/** When changes are written back and failed writebacks are tried again. */
export interface WritebackTimings {
  /** Changes are written back this long after the last change... */
  debounceMs: number;
  /** ...but at the latest this long after the first change that isn't written back yet. */
  maxWaitMs: number;
  /** Delay before the first retry of a failed writeback. It doubles with every further failure... */
  minRetryDelayMs: number;
  /** ...up to this. */
  maxRetryDelayMs: number;
}

export const DEFAULT_WRITEBACK_TIMINGS: WritebackTimings = {
  debounceMs: 5000,
  maxWaitMs: 60_000,
  minRetryDelayMs: 1000,
  maxRetryDelayMs: 60_000,
};

export interface WritebackOptions extends Partial<WritebackTimings> {
  /** Writes the current state back. Rejects if that failed. */
  write(): Promise<void>;
  /** Whether a failed write is tried again after a delay. Otherwise, it waits for the next change. */
  isRetryable(error: unknown): boolean;
  onSuccess?(): void;
  /**
   * Called after a failed write. `retryInMs` is the delay before it is tried again, or
   * `undefined` if it isn't.
   */
  onFailure?(error: unknown, retryInMs: number | undefined): void;
  /** Called whenever a write finished, or wasn't needed when one was due. */
  onSettled?(): void;
}

/** Writes the changes of one document back, at most one write at a time. */
export interface Writeback {
  /**
   * Records a change, which is written back after the debounce delay or the maximum wait. With
   * `now`, it is written right away instead, or right after a running write, e.g. a new metamodel
   * that other users can only show once the backend has it. A failed write is still retried only
   * after its delay, and nothing is written while paused.
   */
  markChanged(options?: { now?: boolean }): void;
  /**
   * Writes the changes back now instead of waiting, e.g. when the last user left. Waits for a
   * running write first, and resolves when everything is written or the write failed. With
   * `retry: false`, a failed write is not tried again. With `force: true`, changes are written
   * even if the last write failed and nothing changed since.
   */
  flush(options?: { retry?: boolean; force?: boolean }): Promise<void>;
  /** Whether there are changes that are not written back yet. */
  readonly hasChanges: boolean;
  /** Whether a write is running or waits to be tried again. */
  readonly busy: boolean;
  /**
   * Stops writing back until {@link resume}, e.g. while the document is reloaded from the backend:
   * a pending write or retry is cancelled, and neither changes nor {@link flush} start a write.
   * Resolves once a running write finished; if it fails, it isn't retried.
   */
  pause(): Promise<void>;
  /**
   * Writes back again after {@link pause}. With `discardChanges`, all changes so far count as
   * written, e.g. because the document now has the backend's state. Otherwise they are written
   * after the debounce delay.
   */
  resume(options: { discardChanges: boolean }): void;
  /** Stops all timers. Nothing is written back afterwards. */
  dispose(): void;
}

/**
 * Creates the writeback of one document.
 *
 * - A write always writes the complete current state, so changes made while a write runs are
 *   written by the next one.
 * - A failed write keeps the changes. If it is retryable, it is tried again after a growing delay;
 *   changes meanwhile don't shorten that delay. Otherwise it is tried again after the next change,
 *   so an invalid state isn't sent again and again.
 */
export function createWriteback(options: WritebackOptions): Writeback {
  const timings = { ...DEFAULT_WRITEBACK_TIMINGS, ...withoutUndefined(options) };
  /** Number of changes so far. */
  let version = 0;
  /** The version the last successful write contained. */
  let savedVersion = 0;
  let running: Promise<void> | undefined;
  /** Whether a write was due while one was running, so another one follows right away. */
  let writeAgain = false;
  /** Whether the last write failed and isn't tried again before the next change. */
  let blocked = false;
  /** Retryable failures in a row. */
  let failures = 0;
  let debounceTimer: NodeJS.Timeout | undefined;
  let maxWaitTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  let paused = false;

  const hasChanges = () => version !== savedVersion;

  function clearTimers(): void {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    clearTimeout(retryTimer);
    debounceTimer = maxWaitTimer = retryTimer = undefined;
  }

  /** Starts a write if one is needed. A running write is followed by another one. */
  function writeNow(retry: boolean, force = false): void {
    if (disposed || paused) {
      return;
    }
    if (running !== undefined) {
      writeAgain = true;
      return;
    }
    clearTimers();
    if ((blocked && !force) || !hasChanges()) {
      callSafely(() => options.onSettled?.());
      return;
    }
    const writtenVersion = version;
    running = options
      .write()
      .then(
        () => {
          savedVersion = writtenVersion;
          failures = 0;
          if (!disposed) {
            callSafely(() => options.onSuccess?.());
          }
        },
        (error: unknown) => {
          let retryInMs: number | undefined;
          if (paused) {
            // Retried after resume, if the changes aren't discarded.
            failures = 0;
          } else if (retry && options.isRetryable(error)) {
            failures += 1;
            retryInMs = Math.min(
              timings.minRetryDelayMs * 2 ** (failures - 1),
              timings.maxRetryDelayMs,
            );
          } else {
            failures = 0;
            // A change made while the write ran may have fixed the problem.
            blocked = version === writtenVersion;
          }
          if (disposed) {
            return;
          }
          callSafely(() => options.onFailure?.(error, retryInMs));
          if (retryInMs !== undefined) {
            // The retry writes everything; changes meanwhile don't start an earlier write.
            clearTimers();
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              writeNow(true);
            }, retryInMs);
          }
        },
      )
      .finally(() => {
        running = undefined;
        if (writeAgain && retryTimer === undefined) {
          writeAgain = false;
          writeNow(retry);
          return;
        }
        writeAgain = false;
        if (!disposed) {
          callSafely(() => options.onSettled?.());
        }
      });
  }

  /** Schedules a write after the debounce delay, and at the latest after the maximum wait. */
  function schedule(): void {
    if (disposed || paused || retryTimer !== undefined) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => writeNow(true), timings.debounceMs);
    maxWaitTimer ??= setTimeout(() => writeNow(true), timings.maxWaitMs);
  }

  return {
    markChanged({ now = false } = {}) {
      if (disposed) {
        return;
      }
      version += 1;
      blocked = false;
      if (now && retryTimer === undefined) {
        writeNow(true);
      } else {
        schedule();
      }
    },
    async flush({ retry = true, force = false } = {}) {
      while (running !== undefined) {
        await running;
      }
      writeNow(retry, force);
      while (running !== undefined) {
        await running;
      }
    },
    get hasChanges() {
      return hasChanges();
    },
    get busy() {
      return running !== undefined || retryTimer !== undefined;
    },
    async pause() {
      paused = true;
      writeAgain = false;
      clearTimers();
      while (running !== undefined) {
        await running;
      }
    },
    resume({ discardChanges }) {
      paused = false;
      failures = 0;
      if (discardChanges) {
        savedVersion = version;
        blocked = false;
      } else if (hasChanges()) {
        schedule();
      }
    },
    dispose() {
      disposed = true;
      clearTimers();
    },
  };
}

/** Calls a callback; an error it throws is logged, so it can't break the writeback. */
function callSafely(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    console.error('A writeback callback failed:', error);
  }
}

/** The timings among the options that are set. */
function withoutUndefined(options: Partial<WritebackTimings>): Partial<WritebackTimings> {
  const timings: Partial<WritebackTimings> = {};
  for (const key of Object.keys(DEFAULT_WRITEBACK_TIMINGS) as (keyof WritebackTimings)[]) {
    if (options[key] !== undefined) {
      timings[key] = options[key];
    }
  }
  return timings;
}
