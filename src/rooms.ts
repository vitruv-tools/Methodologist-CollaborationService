import { docs, getYDoc, type WSSharedDoc } from 'y-websocket/bin/utils';
import { BackendError, type BackendClient, type ProjectDetails } from './backend.js';
import { EPOCH, STATUS } from './document.js';
import { describeError } from './errors.js';
import {
  applyBackendState,
  DocumentError,
  fillDocument,
  SERVER_ORIGIN,
  setWritebackError,
  toSyncChanges,
  type SentState,
} from './projectSync.js';
import { ServiceTokenError } from './serviceToken.js';
import { createWriteback, type Writeback, type WritebackTimings } from './writeback.js';

export interface RoomsOptions {
  /** Loads projects and writes their changes back. */
  backend: BackendClient;
  /** Defaults to {@link DEFAULT_WRITEBACK_TIMINGS}. */
  writeback?: Partial<WritebackTimings>;
}

/** A room a connection uses: the shared document of one project. */
export interface JoinedRoom {
  readonly doc: WSSharedDoc;
  /** Ends this use of the room. Further calls do nothing. */
  release(): void;
}

export interface Rooms {
  /**
   * Joins the room of a project. The first join loads the project into a new document; later ones
   * wait for that. Every join must be released when its connection ends.
   *
   * `epoch` is the epoch of the client's document, if it has one (see `StatusFields.epoch`). Then
   * the client may only join the current room with that epoch: it never creates or loads one.
   *
   * @throws BackendError or ServiceTokenError if loading the project failed
   * @throws RoomsClosedError if the rooms are being closed
   * @throws OutdatedDocumentError if `epoch` is given but isn't the current room's
   */
  join(roomName: string, projectId: string, epoch?: string): Promise<JoinedRoom>;
  /**
   * Writes back the changes of all rooms, once, and drops the rooms. Gives up waiting after
   * `timeoutMs`. Later joins fail.
   */
  closeAll(timeoutMs: number): Promise<void>;
}

/**
 * Thrown by {@link Rooms.join} for a document of a room that no longer exists: its epoch isn't the
 * current room's, or the project has no room.
 */
export class OutdatedDocumentError extends Error {
  constructor() {
    super('The document belongs to an earlier room of the project');
    this.name = 'OutdatedDocumentError';
  }
}

/** Thrown by {@link Rooms.join} once the rooms are being closed. */
export class RoomsClosedError extends Error {
  constructor() {
    super('The server is shutting down');
    this.name = 'RoomsClosedError';
  }
}

interface Room {
  readonly name: string;
  readonly projectId: string;
  readonly doc: WSSharedDoc;
  /** Random ID of this room, in the document's `status` (see `StatusFields.epoch`). */
  readonly epoch: string;
  /** Resolves when the project was loaded into the document. */
  loaded: Promise<void>;
  isLoaded: boolean;
  /** Number of joins that are not released yet. */
  users: number;
  dropped: boolean;
  writeback?: Writeback;
  /** The project as the backend returned it last. */
  known?: ProjectDetails;
  /**
   * What the last sync request contained, as long as the backend's state after it isn't brought
   * into the document yet.
   */
  unconfirmed?: SentState;
}

/**
 * Creates the rooms of a collaboration server. Each room holds the shared document of one project,
 * loaded from the backend when the first user joins.
 *
 * - Nobody gets the document before it is loaded. If loading fails, the document is dropped
 *   without ever being written back, since an empty document would delete the project.
 * - Changes from clients start a writeback of the room's {@link Writeback}; the server's own
 *   changes (origin {@link SERVER_ORIGIN}) don't.
 * - When the last user leaves, the changes are written back. The room is dropped only once
 *   everything is written back, so a user who comes back meanwhile gets the same document. A room
 *   whose changes the backend rejected (and rejects again when the last user leaves) stays in
 *   memory until a user fixes them or the server stops.
 *
 * The documents are y-websocket's: each room's document is in its `docs` map under the room name,
 * where `setupWSConnection` finds it. Only one server per process may use them.
 */
export function createRooms({ backend, writeback: timings }: RoomsOptions): Rooms {
  const rooms = new Map<string, Room>();
  let closing = false;

  function open(name: string, projectId: string): Room {
    if (docs.has(name)) {
      throw new Error(`y-websocket already has a document for room ${name}`);
    }
    const room: Room = {
      name,
      projectId,
      doc: getYDoc(name),
      epoch: crypto.randomUUID(),
      loaded: Promise.resolve(),
      isLoaded: false,
      users: 0,
      dropped: false,
    };
    room.loaded = backend
      .getProject(projectId)
      .then((project) => loaded(room, project))
      .catch((error: unknown) => {
        // Also if filling the document failed: the next user tries loading again.
        drop(room);
        throw error;
      });
    return room;
  }

  /** Fills the document with the loaded project and starts writing its changes back. */
  function loaded(room: Room, project: ProjectDetails): void {
    if (room.dropped) {
      throw new RoomsClosedError();
    }
    const skipped = fillDocument(room.doc, project);
    room.doc.transact(() => room.doc.getMap(STATUS).set(EPOCH, room.epoch), SERVER_ORIGIN);
    if (skipped.length > 0) {
      console.error(
        `Left out layout entries of ${room.name} that can't be stored: ${skipped.join(', ')}`,
      );
    }
    room.known = project;
    room.writeback = createWriteback({
      ...timings,
      write: () => write(room),
      isRetryable,
      onSuccess: () => setWritebackError(room.doc, null),
      onFailure: (error, retryInMs) => reportFailure(room, error, retryInMs),
      onSettled: () => dropIfDone(room),
    });
    room.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== SERVER_ORIGIN) {
        room.writeback?.markChanged();
      }
    });
    room.isLoaded = true;
    dropIfDone(room);
  }

  /** Writes the current state back, then brings the backend's IDs into the document. */
  async function write(room: Room): Promise<void> {
    if (room.unconfirmed !== undefined) {
      // The last request may have reached the backend even though it failed, so its new elements
      // must get their IDs first. Sending them again without would create them again.
      refresh(room, room.unconfirmed, await backend.getProject(room.projectId), false);
    }
    const { changes, sent } = toSyncChanges(room.doc, room.known as ProjectDetails);
    room.unconfirmed = sent;
    await backend.syncChanges(room.projectId, changes);
    try {
      refresh(room, sent, await backend.getProject(room.projectId), true);
    } catch (error) {
      console.error(
        `Loading ${room.name} after writing it back failed; it is loaded again before the next writeback: ${describeError(error)}`,
      );
    }
  }

  function refresh(room: Room, sent: SentState, project: ProjectDetails, applied: boolean): void {
    applyBackendState(room.doc, sent, project, { applied });
    room.known = project;
    room.unconfirmed = undefined;
  }

  function reportFailure(room: Room, error: unknown, retryInMs: number | undefined): void {
    const retrying = retryInMs === undefined ? '' : `, trying again in ${retryInMs} ms`;
    const detail = error instanceof BackendError && error.detail ? ` (${error.detail})` : '';
    console.error(`Writing back ${room.name} failed${retrying}: ${describeError(error)}${detail}`);
    setWritebackError(
      room.doc,
      retryInMs === undefined
        ? `The changes could not be saved: ${reasonForUsers(error)}`
        : `The changes could not be saved yet and are tried again: ${reasonForUsers(error)}`,
    );
  }

  function leave(room: Room): void {
    if (room.users > 0 || !room.isLoaded) {
      return;
    }
    // Written back right away instead of after the delay, also if the last writeback was rejected:
    // the backend may accept it now. dropIfDone runs when that finished.
    void room.writeback?.flush({ force: true });
  }

  function dropIfDone(room: Room): void {
    const writeback = room.writeback;
    if (room.users === 0 && room.isLoaded && writeback && !writeback.busy && !writeback.hasChanges) {
      drop(room);
    }
  }

  function drop(room: Room): void {
    if (room.dropped) {
      return;
    }
    room.dropped = true;
    room.writeback?.dispose();
    if (rooms.get(room.name) === room) {
      rooms.delete(room.name);
    }
    if (docs.get(room.name) === room.doc) {
      docs.delete(room.name);
    }
    room.doc.destroy();
  }

  return {
    async join(roomName, projectId, epoch) {
      if (closing) {
        throw new RoomsClosedError();
      }
      let room = rooms.get(roomName);
      if (epoch !== undefined && (room === undefined || room.epoch !== epoch)) {
        throw new OutdatedDocumentError();
      }
      if (room === undefined) {
        room = open(roomName, projectId);
        rooms.set(roomName, room);
      }
      const joined = room;
      joined.users += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          joined.users -= 1;
          leave(joined);
        }
      };
      try {
        await joined.loaded;
      } catch (error) {
        release();
        throw error;
      }
      return { doc: joined.doc, release };
    },

    async closeAll(timeoutMs) {
      closing = true;
      const all = [...rooms.values()];
      const writebacks = all.map(async (room) => {
        try {
          await room.loaded;
        } catch {
          return; // nothing was loaded, so there is nothing to write back
        }
        await room.writeback?.flush({ retry: false, force: true });
      });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(writebacks),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      for (const room of all) {
        if (room.writeback?.hasChanges) {
          const reason = room.doc.getMap('status').get('writebackError');
          console.error(
            `The latest changes of ${room.name} could not be saved before shutting down${typeof reason === 'string' ? `: ${reason}` : ''}`,
          );
        }
        drop(room);
      }
    },
  };
}

/**
 * Whether a failed writeback is tried again later: the backend or Keycloak didn't answer, failed,
 * or asked to wait. Other answers (e.g. `400` for an invalid state) would come again.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ServiceTokenError) {
    return true;
  }
  if (error instanceof BackendError) {
    return error.status === undefined || error.status >= 500 || error.status === 429;
  }
  return false;
}

/** Why a writeback failed, for the users of the room. */
function reasonForUsers(error: unknown): string {
  if (error instanceof BackendError) {
    if (error.detail !== undefined) {
      return error.detail;
    }
    return error.status === undefined
      ? 'the backend is not available'
      : `the backend answered with status ${error.status}`;
  }
  if (error instanceof ServiceTokenError) {
    return 'the collaboration server could not log in to the backend';
  }
  if (error instanceof DocumentError) {
    return error.message;
  }
  return 'an unexpected error occurred';
}
