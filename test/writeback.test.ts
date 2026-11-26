import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteback, DEFAULT_WRITEBACK_TIMINGS, type Writeback } from '../src/writeback.js';

const TIMINGS = { debounceMs: 5000, maxWaitMs: 60_000, minRetryDelayMs: 1000, maxRetryDelayMs: 8000 };

class Retryable extends Error {}
class Rejected extends Error {}

/**
 * Results of the next writes, in order; a write without one succeeds. A gate makes the write run
 * until it opens, and then fail with `error` if it has one.
 */
let results: (Error | { gate: Promise<void>; error?: Error })[];
let writes: number;
let failures: [unknown, number | undefined][];
let successes: number;
let settled: number;
let writeback: Writeback;

beforeEach(() => {
  vi.useFakeTimers();
  results = [];
  writes = 0;
  failures = [];
  successes = 0;
  settled = 0;
  writeback = createWriteback({
    ...TIMINGS,
    write: async () => {
      writes += 1;
      const result = results.shift();
      if (result instanceof Error) {
        throw result;
      }
      if (result !== undefined) {
        await result.gate;
        if (result.error !== undefined) {
          throw result.error;
        }
      }
    },
    isRetryable: (error) => error instanceof Retryable,
    onSuccess: () => {
      successes += 1;
    },
    onFailure: (error, retryInMs) => failures.push([error, retryInMs]),
    onSettled: () => {
      settled += 1;
    },
  });
});

afterEach(() => {
  writeback.dispose();
  vi.useRealTimers();
});

/** A write that runs until `open` is called, and then fails with `error` if given. */
function slowWrite(error?: Error): () => void {
  let open = () => {};
  results.push({ gate: new Promise<void>((resolve) => (open = resolve)), error });
  return open;
}

describe('timing', () => {
  it('writes 5 seconds after the last change', async () => {
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(3000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(4999);
    expect(writes).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

    expect(writes).toBe(1);
    expect(writeback.hasChanges).toBe(false);
  });

  it('writes at the latest 60 seconds after the first change', async () => {
    for (let second = 0; second < 59; second += 1) {
      writeback.markChanged();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(writes).toBe(0);

    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes).toBe(1);
  });

  it('does not write without changes', async () => {
    await vi.advanceTimersByTimeAsync(120_000);
    await writeback.flush();

    expect(writes).toBe(0);
  });

  it('writes right away when flushed', async () => {
    writeback.markChanged();

    await writeback.flush();

    expect(writes).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toBe(1);
  });
});

describe('a change that must not wait', () => {
  it('is written right away, without the debounce delay', async () => {
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toBe(1);
    expect(writeback.hasChanges).toBe(false);
  });

  it('is written right away also while other changes keep postponing the write', async () => {
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(4000);
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toBe(1);
  });

  it('is written right after a running write, with the next write', async () => {
    const open = slowWrite();
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toBe(1);

    open();
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });

  it('does not shorten the delay before a failed write is retried', async () => {
    results.push(new Retryable());
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toEqual([[expect.any(Retryable), 1000]]);

    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(writes).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toBe(2);
  });

  it('is written again after a write that was rejected', async () => {
    results.push(new Rejected());
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);

    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toBe(2);
  });

  it('is not written while paused, and after resume like any other change', async () => {
    await writeback.pause();
    writeback.markChanged({ now: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toBe(0);

    writeback.resume({ discardChanges: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(1);
  });
});

describe('one write at a time', () => {
  it('writes changes made during a write with the next write', async () => {
    writeback.markChanged();
    const open = slowWrite();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(1);

    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(1);
    expect(writeback.busy).toBe(true);

    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });

  it('keeps changes made during a write that succeeds', async () => {
    writeback.markChanged();
    const open = slowWrite();
    await vi.advanceTimersByTimeAsync(5000);
    writeback.markChanged();

    open();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeback.hasChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });

  it('waits for a running write when flushed, then writes what changed meanwhile', async () => {
    writeback.markChanged();
    const open = slowWrite();
    await vi.advanceTimersByTimeAsync(5000);
    writeback.markChanged();

    const flushed = writeback.flush();
    open();
    await flushed;

    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });
});

describe('a retryable failure', () => {
  it('is retried with a growing delay up to the maximum', async () => {
    results.push(new Retryable(), new Retryable(), new Retryable(), new Retryable(), new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
    expect(writes).toBe(5);
    await vi.advanceTimersByTimeAsync(8000);

    expect(writes).toBe(6);
    expect(failures.map(([, retryInMs]) => retryInMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(writeback.hasChanges).toBe(false);
  });

  it('keeps the changes until the write succeeds', async () => {
    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    expect(writeback.hasChanges).toBe(true);
    expect(writeback.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeback.hasChanges).toBe(false);
    expect(successes).toBe(1);
  });

  it('is not retried earlier because of new changes', async () => {
    results.push(new Retryable(), new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toBe(2);

    for (let i = 0; i < 10; i += 1) {
      writeback.markChanged();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(writes).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toBe(3);
    expect(writeback.hasChanges).toBe(false);
  });

  it('is retried right away when flushed', async () => {
    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    await writeback.flush();

    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });

  it('is not retried when flushed without retry', async () => {
    results.push(new Retryable());
    writeback.markChanged();

    await writeback.flush({ retry: false });

    expect(failures).toEqual([[expect.any(Retryable), undefined]]);
    expect(writeback.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toBe(1);
  });
});

describe('a failure that is not retryable', () => {
  it('is not retried until the next change', async () => {
    results.push(new Rejected());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    await vi.advanceTimersByTimeAsync(600_000);
    await writeback.flush();
    expect(writes).toBe(1);
    expect(failures).toEqual([[expect.any(Rejected), undefined]]);
    expect(writeback.hasChanges).toBe(true);
    expect(writeback.busy).toBe(false);

    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });

  it('is retried if something changed while the write ran', async () => {
    let open = () => {};
    results.push({ gate: new Promise<void>((resolve) => (open = resolve)) });
    writeback = createWriteback({
      ...TIMINGS,
      write: async () => {
        writes += 1;
        if (writes === 1) {
          await (results.shift() as { gate: Promise<void> }).gate;
          throw new Rejected();
        }
      },
      isRetryable: () => false,
    });
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    writeback.markChanged();

    open();
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });
});

describe('callbacks', () => {
  it('report success, failure and when a write settled', async () => {
    results.push(new Rejected());
    writeback.markChanged();
    await writeback.flush();
    writeback.markChanged();
    await writeback.flush();

    expect(failures).toHaveLength(1);
    expect(successes).toBe(1);
    expect(settled).toBe(2);
  });

  it('report settled also when there is nothing to write', async () => {
    await writeback.flush();

    expect(settled).toBe(1);
  });

  it('cannot break the writeback by throwing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeback = createWriteback({
      ...TIMINGS,
      write: async () => {
        writes += 1;
      },
      isRetryable: () => false,
      onSuccess: () => {
        throw new Error('broken callback');
      },
    });
    writeback.markChanged();

    await writeback.flush();

    expect(writeback.hasChanges).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('dispose', () => {
  it('stops pending writes and retries', async () => {
    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    writeback.dispose();
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(writes).toBe(1);
  });
});

describe('defaults', () => {
  it('write 5 seconds after the last change and at the latest after 60 seconds', async () => {
    writeback.dispose();
    writeback = createWriteback({ write: async () => void (writes += 1), isRetryable: () => true });

    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(4999);
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toBe(1);

    for (let second = 0; second < 60; second += 1) {
      writeback.markChanged();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(writes).toBe(2);
    expect(DEFAULT_WRITEBACK_TIMINGS).toMatchObject({ debounceMs: 5000, maxWaitMs: 60_000 });
  });
});

describe('continuous editing', () => {
  it('is written every 60 seconds', async () => {
    for (let second = 0; second < 130; second += 1) {
      writeback.markChanged();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(writes).toBe(2);
  });

  it('starts a new maximum wait after a write', async () => {
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(1000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(1);

    await vi.advanceTimersByTimeAsync(53_000); // 59 s after the first change
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(4999);
    expect(writes).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toBe(2);
  });
});

describe('retry delays', () => {
  /** A writeback whose first write runs until the returned function is called, then fails retryably. */
  function slowFailingWriteback(retryDelayMs: number): () => void {
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    writeback.dispose();
    writeback = createWriteback({
      ...TIMINGS,
      minRetryDelayMs: retryDelayMs,
      maxRetryDelayMs: retryDelayMs,
      write: async () => {
        writes += 1;
        if (writes === 1) {
          await gate;
          throw new Retryable();
        }
      },
      isRetryable: (error) => error instanceof Retryable,
    });
    return open;
  }

  it('are not shortened by changes made while the failed write ran', async () => {
    const open = slowFailingWriteback(10_000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    writeback.markChanged();

    open();
    await vi.advanceTimersByTimeAsync(9999);
    expect(writes).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toBe(2);
  });

  it('are not shortened by a write that was due while the failed write ran', async () => {
    const open = slowFailingWriteback(1000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(1);

    open();
    await vi.advanceTimersByTimeAsync(999);
    expect(writes).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toBe(2);
  });

  it('are not shortened by new changes, also when longer than the debounce delay', async () => {
    results.push(new Retryable(), new Retryable(), new Retryable(), new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000 + 1000 + 2000 + 4000); // the fourth retry follows in 8 s
    expect(writes).toBe(4);

    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(7999);
    expect(writes).toBe(4);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toBe(5);
  });

  it('start again with the shortest delay after a write succeeded', async () => {
    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000 + 1000);
    expect(writeback.hasChanges).toBe(false);

    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    expect(failures.map(([, retryInMs]) => retryInMs)).toEqual([1000, 1000]);
  });
});

describe('a forced flush', () => {
  it('writes changes whose last write was rejected', async () => {
    results.push(new Rejected());
    writeback.markChanged();
    await writeback.flush();
    await writeback.flush();
    expect(writes).toBe(1);

    await writeback.flush({ force: true });

    expect(writes).toBe(2);
    expect(writeback.hasChanges).toBe(false);
  });
});

describe('pause', () => {
  it('cancels a pending write, and changes start none while paused', async () => {
    writeback.markChanged();

    void writeback.pause();
    await vi.advanceTimersByTimeAsync(120_000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(writes).toBe(0);
    expect(writeback.hasChanges).toBe(true);
  });

  it('cancels a pending retry', async () => {
    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    await writeback.pause();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(writes).toBe(1);
  });

  it('resolves once the running write finished', async () => {
    const open = slowWrite();
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    let paused = false;

    const pausing = writeback.pause().then(() => (paused = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(paused).toBe(false);
    expect(writeback.busy).toBe(true);
    open();
    await pausing;

    expect(writeback.busy).toBe(false);
  });

  it('does not retry a write that fails while pausing', async () => {
    const open = slowWrite(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    const pausing = writeback.pause();
    open();
    await pausing;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(writes).toBe(1);
    expect(failures).toEqual([[expect.any(Retryable), undefined]]);
    expect(writeback.busy).toBe(false);
  });

  it('does not write a change made during the running write when it finishes', async () => {
    const open = slowWrite();
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000); // due while the write runs

    const pausing = writeback.pause();
    open();
    await pausing;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(writes).toBe(1);
    expect(writeback.hasChanges).toBe(true);
  });

  it('makes flushing write nothing, also when forced', async () => {
    writeback.markChanged();
    await writeback.pause();

    await writeback.flush();
    await writeback.flush({ force: true });

    expect(writes).toBe(0);
  });
});

describe('resume', () => {
  it('with discarded changes counts all changes so far as written', async () => {
    writeback.markChanged();
    await writeback.pause();
    writeback.markChanged();

    writeback.resume({ discardChanges: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toBe(0);
    expect(writeback.hasChanges).toBe(false);

    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(1);
  });

  it('without discarding writes the changes after the debounce delay', async () => {
    writeback.markChanged();
    await writeback.pause();

    writeback.resume({ discardChanges: false });
    await vi.advanceTimersByTimeAsync(4999);
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(writes).toBe(1);
  });

  it('with discarded changes starts retries again with the shortest delay', async () => {
    results.push(new Retryable(), new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    await writeback.pause();

    writeback.resume({ discardChanges: true });
    results.push(new Retryable());
    writeback.markChanged();
    await vi.advanceTimersByTimeAsync(5000);

    expect(failures.map(([, retryInMs]) => retryInMs)).toEqual([1000, 2000, 1000]);
  });
});
