import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docs } from 'y-websocket/bin/utils';
import type { Doc, Map as YMap } from 'yjs';
import { BackendError } from '../src/backend.js';
import { SERVER_ORIGIN, setWritebackError } from '../src/projectSync.js';
import {
  createRooms,
  isRetryable,
  OutdatedDocumentError,
  RoomsClosedError,
  type Rooms,
} from '../src/rooms.js';
import { ServiceTokenError } from '../src/serviceToken.js';
import { Y } from '../src/yjs.js';
import { FakeProjects, gate } from './fakeProjects.js';

const TIMINGS = { debounceMs: 20, maxWaitMs: 200, minRetryDelayMs: 10, maxRetryDelayMs: 40 };

let backend: FakeProjects;
let rooms: Rooms;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  backend = new FakeProjects();
  backend.add('1', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }, { id: 102, sourceId: 2, name: 'Brake' }] });
  rooms = createRooms({ backend, writeback: TIMINGS });
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await rooms.closeAll(1000);
  logged.mockRestore();
});

/** Changes the document as a client would. */
function edit(doc: Doc, change: (doc: Doc) => void): void {
  doc.transact(() => change(doc), 'client');
}

function rename(doc: Doc, name: string): void {
  edit(doc, () => (doc.getMap('models').get('1') as YMap<unknown>).set('name', name));
}

function addRelation(doc: Doc, reactionFileId: number): YMap<unknown> {
  const relation = new Y.Map<unknown>(
    Object.entries({
      backendId: null,
      sourceId: 1,
      targetId: 2,
      reactionFileId,
      fineGranular: [],
      softDeleted: false,
      softDeletedVia: null,
    }),
  );
  edit(doc, () => doc.getMap('relations').set('new-relation', relation));
  return relation;
}

function addView(doc: Doc, name: string): YMap<unknown> {
  const view = new Y.Map<unknown>(
    Object.entries({
      backendId: null,
      name,
      description: new Y.Text(),
      fileStorageId: 70,
      metaModelIds: [1],
      softDeleted: false,
      softDeletedVia: null,
    }),
  );
  edit(doc, () => doc.getMap('views').set('new-view', view));
  return view;
}

/** Lets the next sync request reach the backend, but fail as if it had timed out. */
function timeOutAfterApplyingNextSync(): void {
  const send = backend.syncChanges.bind(backend);
  let timeouts = 1;
  backend.syncChanges = async (projectId, changes) => {
    await send(projectId, changes);
    if (timeouts-- > 0) {
      throw new BackendError(undefined, 'The backend is not available: timeout');
    }
  };
}

const storedName = () => backend.projects.get('1')?.metaModels[0].name;
const writebackError = (doc: Doc) => doc.getMap('status').get('writebackError');

describe('joining', () => {
  it('loads the project into the document of the room', async () => {
    const { doc } = await rooms.join('vsum:1', '1');

    expect(doc.getMap('models').toJSON()).toEqual({
      '1': { name: 'Car', softDeleted: false, softDeletedVia: null },
      '2': { name: 'Brake', softDeleted: false, softDeletedVia: null },
    });
    expect(backend.loads).toEqual(['1']);
  });

  it("puts the document into y-websocket's docs, built with the server's Yjs", async () => {
    const { doc } = await rooms.join('vsum:1', '1');

    expect(docs.get('vsum:1')).toBe(doc);
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(doc.getMap('models').get('1')).toBeInstanceOf(Y.Map);
  });

  it('loads a project only once for users who join at the same time', async () => {
    const loading = gate();
    backend.nextLoads.push(loading.interruption);

    const joins = [rooms.join('vsum:1', '1'), rooms.join('vsum:1', '1')];
    loading.open();
    const [first, second] = await Promise.all(joins);

    expect(first.doc).toBe(second.doc);
    expect(backend.loads).toEqual(['1']);
  });

  it('gives nobody the document before it is loaded', async () => {
    const loading = gate();
    backend.nextLoads.push(loading.interruption);
    let joined = false;

    const join = rooms.join('vsum:1', '1').then((room) => {
      joined = true;
      return room;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(joined).toBe(false);

    loading.open();
    expect((await join).doc.getMap('models').size).toBe(2);
  });

  it('fails if loading fails, and never writes that document back', async () => {
    backend.nextLoads.push(new BackendError(500, 'status 500'));

    await expect(rooms.join('vsum:1', '1')).rejects.toBeInstanceOf(BackendError);

    expect(docs.has('vsum:1')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(backend.requests).toEqual([]);
  });

  it('loads again for the next user after loading failed', async () => {
    backend.nextLoads.push(new BackendError(undefined, 'timeout'));
    await expect(rooms.join('vsum:1', '1')).rejects.toThrow('timeout');

    const { doc } = await rooms.join('vsum:1', '1');

    expect(doc.getMap('models').size).toBe(2);
    expect(backend.loads).toEqual(['1', '1']);
  });

  it('drops a room whose project could not be filled into the document, so the next user loads it again', async () => {
    const load = backend.getProject.bind(backend);
    let broken = true;
    backend.getProject = async (projectId) => {
      const project = await load(projectId);
      if (broken) {
        broken = false;
        // Yjs can't store an object with its own constructor key.
        const name = { constructor: 'x' } as unknown as string;
        return { ...project, metaModels: [{ id: 101, sourceId: 1, name }] };
      }
      return project;
    };

    await expect(rooms.join('vsum:1', '1')).rejects.toThrow('Unexpected content type');
    expect(docs.has('vsum:1')).toBe(false);

    const { doc } = await rooms.join('vsum:1', '1');
    expect(doc.getMap('models').size).toBe(2);
  });

  it("logs layout entries it can't store", async () => {
    backend.add('3', { layout: { note: { constructor: 'x' } } });

    await rooms.join('vsum:3', '3');

    expect(logged).toHaveBeenCalledWith("Left out layout entries of vsum:3 that can't be stored: note");
  });

  it('counts a release only once, also if it is called again', async () => {
    const alice = await rooms.join('vsum:1', '1');
    const bob = await rooms.join('vsum:1', '1');

    alice.release();
    alice.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(docs.get('vsum:1')).toBe(bob.doc);
  });
  it('drops a room whose user left right after it was loaded', async () => {
    const room = await rooms.join('vsum:1', '1');

    room.release();
    room.release();

    expect(docs.has('vsum:1')).toBe(false);
    expect(backend.requests).toEqual([]);
  });
});

describe('writing back', () => {
  it('writes a change back after the delay', async () => {
    const { doc } = await rooms.join('vsum:1', '1');

    rename(doc, 'Vehicle');

    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));
    expect(backend.requests).toHaveLength(1);
  });

  it("doesn't start a writeback for the server's own changes", async () => {
    const { doc } = await rooms.join('vsum:1', '1');

    setWritebackError(doc, 'Something failed');
    doc.transact(
      () => (doc.getMap('models').get('1') as YMap<unknown>).set('name', 'Vehicle'),
      SERVER_ORIGIN,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(backend.requests).toEqual([]);
  });
  it('creates a new relation once and fills in its backend ID', async () => {
    const { doc } = await rooms.join('vsum:1', '1');

    const relation = addRelation(doc, 50);
    await vi.waitFor(() => expect(relation.get('backendId')).toBe(1000));
    rename(doc, 'Vehicle');
    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));

    expect(backend.changes).toEqual(['create relation 1000', 'rename model 1']);
  });

  it('writes back when the last user leaves, and drops the room afterwards', async () => {
    rooms = createRooms({ backend, writeback: { ...TIMINGS, debounceMs: 60_000, maxWaitMs: 60_000 } });
    const alice = await rooms.join('vsum:1', '1');
    const bob = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Vehicle');

    alice.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.requests).toEqual([]);

    bob.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
    expect(storedName()).toBe('Vehicle');
  });

  it('keeps the room for a user who comes back during the last writeback', async () => {
    const saving = gate();
    backend.nextSyncs.push(saving.interruption);
    const alice = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Vehicle');
    alice.release();
    await vi.waitFor(() => expect(backend.requests).toHaveLength(1));

    const again = await rooms.join('vsum:1', '1');
    rename(again.doc, 'Truck');
    saving.open();

    expect(again.doc).toBe(alice.doc);
    await vi.waitFor(() => expect(storedName()).toBe('Truck'));
    expect(docs.get('vsum:1')).toBe(again.doc);
    expect(backend.loads).toEqual(['1', '1', '1']); // opening, then after each of the two writebacks
    again.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
  });

  it('reports a rejected writeback in status and keeps the room and its changes', async () => {
    backend.nextSyncs.push(new BackendError(400, 'status 400', 'View names must be unique'));
    const alice = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Vehicle');
    alice.release();

    await vi.waitFor(() =>
      expect(alice.doc.getMap('status').get('writebackError')).toBe(
        'The changes could not be saved: View names must be unique',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(backend.requests).toHaveLength(1);
    expect(docs.get('vsum:1')).toBe(alice.doc);

    const bob = await rooms.join('vsum:1', '1');
    expect((bob.doc.getMap('models').get('1') as YMap<unknown>).get('name')).toBe('Vehicle');
    rename(bob.doc, 'Car 2');
    await vi.waitFor(() => expect(storedName()).toBe('Car 2'));
    expect(bob.doc.getMap('status').get('writebackError')).toBeNull();
    bob.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
  });

  it('retries a writeback the backend failed, and reports that it is retrying', async () => {
    backend.nextSyncs.push(new BackendError(503, 'status 503'), new BackendError(503, 'status 503'));
    const { doc } = await rooms.join('vsum:1', '1');
    const errors: unknown[] = [];
    doc.getMap('status').observe(() => errors.push(doc.getMap('status').get('writebackError')));

    rename(doc, 'Vehicle');

    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));
    expect(backend.requests).toHaveLength(3);
    expect(errors).toEqual([
      'The changes could not be saved yet and are tried again: the backend answered with status 503',
      null,
    ]);
  });

  it('gives the new elements of a writeback whose outcome is unknown their IDs before retrying', async () => {
    timeOutAfterApplyingNextSync();
    const { doc } = await rooms.join('vsum:1', '1');
    const mapping = {
      sourceId: 'a',
      targetId: 'b',
      lowCodeReactionRequestBase: { name: 'composite_reactions' },
    };
    const relation = new Y.Map<unknown>(
      Object.entries({
        backendId: null,
        sourceId: 1,
        targetId: 2,
        reactionFileId: null,
        fineGranular: [mapping],
        softDeleted: false,
        softDeletedVia: null,
      }),
    );

    edit(doc, () => doc.getMap('relations').set('new-relation', relation));

    // Sending the mapping again without its ID would make the backend generate its file again.
    await vi.waitFor(() =>
      expect(relation.get('fineGranular')).toEqual([{ ...mapping, id: 1002, reactionFileStorageId: 1001 }]),
    );
    await vi.waitFor(() => expect(backend.requests).toHaveLength(2));
    expect(backend.changes).toEqual(['create relation 1000', 'create mapping 1002']);
    expect(writebackError(doc)).toBeNull();
  });

  it('gives new elements their IDs before the next writeback if loading after a writeback failed', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    backend.nextLoads.push(new BackendError(500, 'status 500'));
    const view = addView(doc, 'Details');
    await vi.waitFor(() => expect(backend.requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.get('backendId')).toBeNull();

    // Without its ID, the renamed view would be created again and the old one deleted.
    edit(doc, () => view.set('name', 'Brake details'));

    await vi.waitFor(() => expect(backend.changes).toEqual(['create view 1000', 'update view 1000']));
    expect(view.get('backendId')).toBe(1000);
  });

  it('retries the last writeback when the backend fails, and drops the room only after it succeeded', async () => {
    rooms = createRooms({ backend, writeback: { ...TIMINGS, debounceMs: 60_000, maxWaitMs: 60_000 } });
    backend.nextSyncs.push(new BackendError(503, 'status 503'), new BackendError(503, 'status 503'));
    const alice = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Vehicle');

    alice.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(docs.has('vsum:1')).toBe(true);

    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
    expect(backend.requests).toHaveLength(3);
  });

  it('tries a rejected writeback once more when the last user leaves', async () => {
    backend.nextSyncs.push(new BackendError(409, 'status 409'));
    const alice = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Vehicle');
    await vi.waitFor(() =>
      expect(writebackError(alice.doc)).toBe(
        'The changes could not be saved: the backend answered with status 409',
      ),
    );

    alice.release();

    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
  });

  it("reports elements it can't read in status instead of writing them back", async () => {
    const { doc } = await rooms.join('vsum:1', '1');

    edit(doc, () => doc.getMap('models').set('1', { name: 'Car' }));

    await vi.waitFor(() =>
      expect(writebackError(doc)).toBe("The changes could not be saved: metamodel 1 can't be read"),
    );
    expect(backend.requests).toEqual([]);
  });
});
describe('closing', () => {
  it('writes back all rooms and drops them', async () => {
    backend.add('2');
    rooms = createRooms({ backend, writeback: { ...TIMINGS, debounceMs: 60_000, maxWaitMs: 60_000 } });
    const first = await rooms.join('vsum:1', '1');
    const second = await rooms.join('vsum:2', '2');
    rename(first.doc, 'Vehicle');
    edit(second.doc, (doc) => (doc.getMap('layout').get('metaModels') as YMap<unknown>).set('9', { x: 1, y: 2 }));

    await rooms.closeAll(1000);

    expect(storedName()).toBe('Vehicle');
    expect(backend.projects.get('2')?.layout).toEqual({ metaModels: { '9': { x: 1, y: 2 } }, reactions: {} });
    expect(docs.has('vsum:1') || docs.has('vsum:2')).toBe(false);
  });

  it('gives up waiting after the timeout and says what was lost', async () => {
    backend.nextSyncs.push(gate().interruption);
    const { doc } = await rooms.join('vsum:1', '1');
    rename(doc, 'Vehicle');

    await rooms.closeAll(50);

    expect(docs.has('vsum:1')).toBe(false);
    expect(logged).toHaveBeenCalledWith('The latest changes of vsum:1 could not be saved before shutting down');
  });

  it('tries the last writeback only once, without announcing a retry', async () => {
    backend.nextSyncs.push(new BackendError(503, 'status 503'));
    const { doc } = await rooms.join('vsum:1', '1');
    rename(doc, 'Vehicle');

    await rooms.closeAll(1000);

    expect(logged).toHaveBeenCalledWith('Writing back vsum:1 failed: status 503');
    expect(backend.requests).toHaveLength(1);
  });

  it('rejects users who join afterwards', async () => {
    await rooms.closeAll(1000);

    await expect(rooms.join('vsum:1', '1')).rejects.toBeInstanceOf(RoomsClosedError);
  });

  it('rejects users whose project was still loading', async () => {
    const loading = gate();
    backend.nextLoads.push(loading.interruption);
    const join = rooms.join('vsum:1', '1');

    await rooms.closeAll(10);
    loading.open();

    await expect(join).rejects.toBeInstanceOf(RoomsClosedError);
    expect(docs.has('vsum:1')).toBe(false);
  });
});

describe('isRetryable', () => {
  it.each([
    [new BackendError(undefined, 'timeout'), true],
    [new BackendError(500, 'status 500'), true],
    [new BackendError(503, 'status 503'), true],
    [new BackendError(429, 'status 429'), true],
    [new ServiceTokenError('Keycloak is not available'), true],
    [new BackendError(400, 'status 400'), false],
    [new BackendError(401, 'status 401'), false],
    [new BackendError(404, 'status 404'), false],
    [new BackendError(409, 'status 409'), false],
    [new Error('bug'), false],
  ])('%s → %s', (error, retryable) => {
    expect(isRetryable(error)).toBe(retryable);
  });
});


describe('regenerating and closing', () => {
  it('regenerates a mapping once, also if the first writeback failed', async () => {
    const mapping = (regenerate: boolean) => ({
      id: 81,
      sourceId: 'a',
      targetId: 'b',
      reactionFileStorageId: 60,
      lowCodeReactionRequestBase: { name: 'composite_reactions', regenerate },
    });
    backend.add('1', {
      metaModels: [{ id: 101, sourceId: 1, name: 'Car' }, { id: 102, sourceId: 2, name: 'Brake' }],
      relations: [
        { id: 7, sourceId: 1, targetId: 2, reactionFileStorageId: 50, fineGranularMetaModelRelationSet: [mapping(false)] },
      ],
    });
    backend.nextSyncs.push(new BackendError(503, 'status 503'));
    const { doc } = await rooms.join('vsum:1', '1');
    const relation = doc.getMap('relations').get('7') as YMap<unknown>;

    edit(doc, () => relation.set('fineGranular', [mapping(true)]));
    await vi.waitFor(() => expect(relation.get('fineGranular')).toEqual([mapping(false)]));
    rename(doc, 'Vehicle');
    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));

    // Kept after the failed writeback, so that the retry regenerated the file; set back to false after
    // the successful one, so that the next writeback didn't regenerate it again.
    expect(backend.changes).toEqual(['regenerate mapping 81', 'rename model 1']);
  });

  it('tries a rejected writeback once more when shutting down', async () => {
    backend.nextSyncs.push(new BackendError(409, 'status 409'));
    const { doc } = await rooms.join('vsum:1', '1');
    rename(doc, 'Vehicle');
    await vi.waitFor(() =>
      expect(writebackError(doc)).toBe('The changes could not be saved: the backend answered with status 409'),
    );

    await rooms.closeAll(1000);

    expect(storedName()).toBe('Vehicle');
    expect(backend.requests).toHaveLength(2);
  });
});

describe('epochs', () => {
  const epochOf = (doc: Doc) => doc.getMap('status').get('epoch');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('gives each new room a random epoch in status, set by the server', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    backend.add('2');
    const other = await rooms.join('vsum:2', '2');

    expect(epochOf(doc)).toMatch(UUID);
    expect(epochOf(other.doc)).toMatch(UUID);
    expect(epochOf(other.doc)).not.toBe(epochOf(doc));
  });

  it('gives a room a new epoch when it is created again', async () => {
    const first = await rooms.join('vsum:1', '1');
    const epoch = epochOf(first.doc);
    first.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));

    const second = await rooms.join('vsum:1', '1');

    expect(epochOf(second.doc)).toMatch(UUID);
    expect(epochOf(second.doc)).not.toBe(epoch);
  });

  it("sets the epoch with the server's origin, so it starts no writeback and is never written back", async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    rename(doc, 'Vehicle');

    await vi.waitFor(() => expect(storedName()).toBe('Vehicle'));

    expect(JSON.stringify(backend.requests)).not.toContain(String(epochOf(doc)));
  });

  it('lets a document of the current room join with its epoch', async () => {
    const alice = await rooms.join('vsum:1', '1');

    const again = await rooms.join('vsum:1', '1', String(epochOf(alice.doc)));

    expect(again.doc).toBe(alice.doc);
  });

  it('rejects a document whose room no longer exists, without loading the project', async () => {
    const alice = await rooms.join('vsum:1', '1');
    const epoch = String(epochOf(alice.doc));
    alice.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));

    await expect(rooms.join('vsum:1', '1', epoch)).rejects.toBeInstanceOf(OutdatedDocumentError);

    expect(backend.loads).toEqual(['1']);
    expect(docs.has('vsum:1')).toBe(false);
  });

  it('rejects a document of an earlier room after the room was created again', async () => {
    const alice = await rooms.join('vsum:1', '1');
    const epoch = String(epochOf(alice.doc));
    alice.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
    const bob = await rooms.join('vsum:1', '1');

    await expect(rooms.join('vsum:1', '1', epoch)).rejects.toBeInstanceOf(OutdatedDocumentError);

    // The rejected join doesn't count as a user: when Bob leaves, the room is dropped.
    bob.release();
    await vi.waitFor(() => expect(docs.has('vsum:1')).toBe(false));
  });

  it('lets a document join its room while that waits for its last writeback', async () => {
    const saving = gate();
    backend.nextSyncs.push(saving.interruption);
    const alice = await rooms.join('vsum:1', '1');
    const epoch = String(epochOf(alice.doc));
    rename(alice.doc, 'Vehicle');
    alice.release();
    await vi.waitFor(() => expect(backend.requests).toHaveLength(1));

    const again = await rooms.join('vsum:1', '1', epoch);
    saving.open();

    expect(again.doc).toBe(alice.doc);
    again.release();
  });

  it('keeps the epoch of a room when its project is reloaded', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    const epoch = String(epochOf(doc));
    setWritebackError(doc, 'The changes could not be saved');
    backend.projects.get('1')!.metaModels[0].name = 'Vehicle';

    await rooms.reload('vsum:1');

    expect(epochOf(doc)).toBe(epoch);
    const again = await rooms.join('vsum:1', '1', epoch);
    expect(again.doc).toBe(doc);
  });

  it('checks the epoch, not what a client wrote into status', async () => {
    const alice = await rooms.join('vsum:1', '1');
    edit(alice.doc, () => alice.doc.getMap('status').set('epoch', 'forged'));

    await expect(rooms.join('vsum:1', '1', 'forged')).rejects.toBeInstanceOf(OutdatedDocumentError);
  });
});

describe('reloading', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const nameIn = (doc: Doc) => (doc.getMap('models').get('1') as YMap<unknown>).get('name');
  /** Renames metamodel 1 in the backend, outside the document. */
  const renameInBackend = (name: string) => {
    backend.projects.get('1')!.metaModels[0].name = name;
  };

  it('does nothing for a project without a room', async () => {
    await rooms.reload('vsum:1');

    expect(backend.loads).toEqual([]);
    expect(docs.has('vsum:1')).toBe(false);
  });

  it('brings changes made outside the document into it, in the same document', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    renameInBackend('Vehicle');

    await rooms.reload('vsum:1');

    expect(nameIn(doc)).toBe('Vehicle');
    expect(docs.get('vsum:1')).toBe(doc);
    expect(backend.loads).toEqual(['1', '1']);
  });

  it('cancels the pending writeback and drops the changes made since the last one', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    rename(doc, 'Mine');
    renameInBackend('Theirs');

    await rooms.reload('vsum:1');
    await sleep(300);

    expect(backend.requests).toEqual([]);
    expect(nameIn(doc)).toBe('Theirs');
    expect(storedName()).toBe('Theirs');
  });

  it('starts no writeback between the notification and the end of the reload', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    const loading = gate();
    backend.nextLoads.push(loading.interruption);

    const reloading = rooms.reload('vsum:1');
    rename(doc, 'During the reload');
    await sleep(300); // longer than the debounce delay and the maximum wait
    expect(backend.requests).toEqual([]);
    loading.open();
    await reloading;
    await sleep(100);

    expect(backend.requests).toEqual([]);
    expect(nameIn(doc)).toBe('Car');
  });

  it('waits for a running writeback before loading the project', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    const saving = gate();
    backend.nextSyncs.push(saving.interruption);
    rename(doc, 'Mine');
    await vi.waitFor(() => expect(backend.requests).toHaveLength(1));

    const reloading = rooms.reload('vsum:1');
    await sleep(50);
    expect(backend.loads).toEqual(['1']);
    saving.open();
    await reloading;

    // Opening, the IDs after the writeback, then the reload.
    expect(backend.loads).toEqual(['1', '1', '1']);
    expect(nameIn(doc)).toBe('Mine');
    expect(backend.requests).toHaveLength(1);
  });

  it('writes changes made after the reload back as usual, and only those', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    renameInBackend('Vehicle');
    backend.projects.get('1')!.metaModels[1].name = 'Disc brake';
    await rooms.reload('vsum:1');

    rename(doc, 'Truck');

    await vi.waitFor(() => expect(storedName()).toBe('Truck'));
    expect(backend.changes).toEqual(['rename model 1']);
  });

  it('clears the writeback error, which was about the dropped changes', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    setWritebackError(doc, 'The changes could not be saved: View names must be unique');

    await rooms.reload('vsum:1');

    expect(writebackError(doc)).toBeNull();
  });

  it('reloads a project that was still loading once it is loaded', async () => {
    const loading = gate();
    backend.nextLoads.push(loading.interruption);
    const joining = rooms.join('vsum:1', '1');

    const reloading = rooms.reload('vsum:1');
    loading.open();
    await joining;
    await reloading;

    expect(backend.loads).toEqual(['1', '1']);
  });

  it('reloads once more if the backend changes the project again during a reload', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    const loading = gate();
    backend.nextLoads.push(loading.interruption);

    const first = rooms.reload('vsum:1');
    await vi.waitFor(() => expect(backend.loads).toHaveLength(2)); // the reload is loading
    renameInBackend('Second');
    const second = rooms.reload('vsum:1');
    const third = rooms.reload('vsum:1');
    loading.open();
    await Promise.all([first, second, third]);

    expect(backend.loads).toEqual(['1', '1', '1']);
    expect(nameIn(doc)).toBe('Second');
  });

  it('loads only once for notifications that arrive before the reload started loading', async () => {
    await rooms.join('vsum:1', '1');

    await Promise.all([rooms.reload('vsum:1'), rooms.reload('vsum:1'), rooms.reload('vsum:1')]);

    expect(backend.loads).toEqual(['1', '1']);
  });

  it('retries loading with a growing delay, tells the users, and still writes nothing meanwhile', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    backend.nextLoads.push(new BackendError(503, 'status 503'), new BackendError(undefined, 'timeout'));
    renameInBackend('Vehicle');
    const errors: unknown[] = [];
    doc.getMap('status').observe(() => errors.push(writebackError(doc)));

    const reloading = rooms.reload('vsum:1');
    rename(doc, 'Mine');
    await reloading;
    await sleep(100);

    expect(backend.loads).toEqual(['1', '1', '1', '1']);
    expect(nameIn(doc)).toBe('Vehicle');
    expect(backend.requests).toEqual([]);
    expect(errors).toEqual([
      'Changes made outside this document could not be loaded yet, so nothing is saved until they are: the backend answered with status 503',
      'Changes made outside this document could not be loaded yet, so nothing is saved until they are: the backend is not available',
      null,
    ]);
    expect(logged.mock.calls.flat().join(' ')).toContain('Reloading vsum:1 failed, trying again in 10 ms');
  });

  it('drops a room nobody uses anymore instead of reloading it, without writing it back', async () => {
    backend.nextSyncs.push(new BackendError(400, 'status 400'), new BackendError(400, 'status 400'));
    const alice = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Rejected');
    await vi.waitFor(() => expect(writebackError(alice.doc)).not.toBeNull());
    alice.release(); // tries the rejected writeback once more
    await vi.waitFor(() => expect(backend.requests).toHaveLength(2));
    expect(docs.has('vsum:1')).toBe(true); // kept, since its changes were rejected
    const loads = backend.loads.length;

    await rooms.reload('vsum:1');

    expect(docs.has('vsum:1')).toBe(false);
    expect(backend.loads).toHaveLength(loads);
    expect(backend.requests).toHaveLength(2);
    const bob = await rooms.join('vsum:1', '1');
    expect(nameIn(bob.doc)).toBe('Car');
  });

  it('drops the room if its last user leaves during the reload', async () => {
    const alice = await rooms.join('vsum:1', '1');
    rename(alice.doc, 'Mine');
    const loading = gate();
    backend.nextLoads.push(loading.interruption);

    const reloading = rooms.reload('vsum:1');
    alice.release();
    loading.open();
    await reloading;

    expect(docs.has('vsum:1')).toBe(false);
    expect(backend.requests).toEqual([]);
  });

  it('stops waiting for the next attempt when the server shuts down', async () => {
    rooms = createRooms({ backend, writeback: { ...TIMINGS, minRetryDelayMs: 60_000, maxRetryDelayMs: 60_000 } });
    await rooms.join('vsum:1', '1');
    backend.nextLoads.push(new BackendError(503, 'status 503'));
    const reloading = rooms.reload('vsum:1');
    await vi.waitFor(() => expect(backend.loads).toHaveLength(2)); // failed, waits 60 s

    await rooms.closeAll(1000);
    await reloading;

    expect(backend.loads).toHaveLength(2);
    expect(backend.requests).toEqual([]);
  });

  it('stops when the server shuts down, without writing the room back', async () => {
    const { doc } = await rooms.join('vsum:1', '1');
    rename(doc, 'Mine');
    const loading = gate();
    backend.nextLoads.push(loading.interruption);

    const reloading = rooms.reload('vsum:1');
    await rooms.closeAll(1000);
    loading.open();
    await reloading;

    expect(backend.requests).toEqual([]);
    expect(docs.has('vsum:1')).toBe(false);
  });
});
