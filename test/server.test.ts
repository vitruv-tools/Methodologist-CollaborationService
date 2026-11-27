import { connect as connectTcp } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { docs, setPersistence, type WSSharedDoc } from 'y-websocket/bin/utils';
import * as Y from 'yjs';
import { BackendError } from '../src/backend.js';
import { BACKEND_ROLE, createBackendTokenVerifier, type BackendTokenVerifier } from '../src/backendToken.js';
import {
  createCollaborationServer,
  MAX_MESSAGE_BYTES,
  type CollaborationServer,
} from '../src/server.js';
import { details, startFakeBackend, type FakeAnswer, type FakeBackend } from './fakeBackend.js';
import { REALM, startFakeKeycloak, type FakeKeycloak } from './fakeKeycloak.js';
import { FakeProjects, gate } from './fakeProjects.js';

/**
 * The backend's IDs of the users of the tokens. `member-renewed` is another token of `member`,
 * e.g. of a tab that reconnected after the first token expired.
 */
const USERS = { owner: '1', member: '2', 'member-renewed': '2', viewer: '3', member2: '4' } as const;

/**
 * The fake backend knows these tokens. `owner`, `member`, `viewer` and `member2` (another member)
 * have that role in every project except project 404, which doesn't exist, as long as a test
 * doesn't change the project's members (`projects.membersOf`). A user who is no member gets `403`.
 * The other tokens trigger the named problem.
 */
function answer(token: string | undefined, projectId: string): FakeAnswer {
  switch (token) {
    case 'owner':
    case 'member':
    case 'member-renewed':
    case 'viewer':
    case 'member2': {
      if (projectId === '404') {
        return { status: 404 };
      }
      const role = projects.membersOf(projectId).get(USERS[token]);
      return role === undefined ? { status: 403 } : details(role, Number(USERS[token]));
    }
    case 'stranger':
      return { status: 403 };
    case 'broken':
      return { status: 500 };
    case 'slow':
      return 'hang';
    case 'no-json':
      return { status: 200, body: '<html>' };
    case 'no-role':
      return { status: 200, body: { data: {} } };
    case 'unknown-role':
      return details('ADMIN', 1);
    case 'no-user-id':
      return details('OWNER', undefined);
    case 'text-user-id':
      return details('OWNER', '1');
    case 'fractional-user-id':
      return details('OWNER', 1.5);
    case 'negative-user-id':
      return details('OWNER', -1);
    case 'unsafe-user-id':
      return details('OWNER', 2 ** 53);
    default:
      return { status: 401 };
  }
}

/** Answers held back by {@link holdAccess}, in order. */
const accessHolds: { projectId: string; arrived: () => void; released: Promise<void> }[] = [];

/**
 * Holds back the fake backend's next answer about a user's access to the project. Like the real
 * backend's, it is computed when the backend is asked, e.g. before the user is removed, and sent
 * once `open` is called. `requested` resolves once the backend was asked. The server waits for an
 * answer only 300 ms (`backendTimeoutMs`).
 */
function holdAccess(projectId: string): { requested: Promise<void>; open: () => void } {
  let arrived = () => {};
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let open = () => {};
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  accessHolds.push({ projectId, arrived, released });
  return { requested, open };
}

/** Like {@link answer}, but held back if {@link holdAccess} asked for that. */
function answerOrHold(token: string | undefined, projectId: string): FakeAnswer {
  const result = answer(token, projectId);
  const index = accessHolds.findIndex((hold) => hold.projectId === projectId);
  if (index === -1 || result === 'hang') {
    return result;
  }
  const [hold] = accessHolds.splice(index, 1);
  hold.arrived();
  return { ...result, after: hold.released };
}

/** Short delays, so that tests don't wait 5 seconds for a writeback. */
const TIMINGS = { debounceMs: 20, maxWaitMs: 200, minRetryDelayMs: 10, maxRetryDelayMs: 40 };
/** How long a client may take to complete a close of the server before it is terminated. */
const REVOKED_CLOSE_TIMEOUT_MS = 200;

let backend: FakeBackend;
/** Issues the backend's tokens for reload notifications. */
let keycloak: FakeKeycloak;
let backendTokens: BackendTokenVerifier;
/** The backend's internal endpoints, which projects are loaded from and written back to. */
let projects: FakeProjects;
let server: CollaborationServer;
let httpUrl: string;
let wsUrl: string;
const providers: WebsocketProvider[] = [];

beforeAll(async () => {
  backend = await startFakeBackend(answerOrHold);
  keycloak = await startFakeKeycloak();
  backendTokens = createBackendTokenVerifier({ url: keycloak.url, realm: REALM, timeoutMs: 300 });
  projects = new FakeProjects();
  server = createCollaborationServer({
    backendUrl: backend.url,
    backendTimeoutMs: 300,
    backend: projects,
    backendTokens,
    writeback: TIMINGS,
    revokedCloseTimeoutMs: REVOKED_CLOSE_TIMEOUT_MS,
  });
  const port = await server.listen(0);
  httpUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}`;
  // Rejections caused by the backend are logged, which is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // So are closed connections of users who lost access.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const provider of providers.splice(0)) {
    provider.destroy();
  }
  accessHolds.length = 0;
});

afterAll(async () => {
  await server.close();
  await backend.close();
  await keycloak.close();
  vi.restoreAllMocks();
});

/**
 * Connects a new client to the given room and waits until it is synced. The client starts with
 * `doc` if given, otherwise with an empty document. `url` is the server's, by default the one all
 * tests share.
 */
async function connect(
  room: string,
  token: string,
  doc = new Y.Doc(),
  url = wsUrl,
  params: Record<string, string> = {},
): Promise<WebsocketProvider> {
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Clients in one process would otherwise sync through a BroadcastChannel, bypassing the server.
    disableBc: true,
    params: { token, ...params },
  });
  providers.push(provider);
  await new Promise<void>((resolve) => {
    const onSync = (isSynced: boolean) => {
      if (isSynced) {
        provider.off('sync', onSync);
        resolve();
      }
    };
    provider.on('sync', onSync);
  });
  return provider;
}

/** Resolves once the map has the key, i.e. once a change arrived from the server. */
function valueArrives(doc: Y.Doc, key: string): Promise<unknown> {
  const map = doc.getMap('test');
  return new Promise((resolve) => {
    if (map.has(key)) {
      resolve(map.get(key));
      return;
    }
    const observer = () => {
      if (map.has(key)) {
        map.unobserve(observer);
        resolve(map.get(key));
      }
    };
    map.observe(observer);
  });
}

/** Resolves once `provider` sees a user with the given name, i.e. once that user's presence arrived. */
function userAppears(provider: WebsocketProvider, name: string): Promise<void> {
  const awareness = provider.awareness;
  const isThere = () =>
    [...awareness.getStates().values()].some((state) => state.user?.name === name);
  return new Promise((resolve) => {
    if (isThere()) {
      resolve();
      return;
    }
    const onChange = () => {
      if (isThere()) {
        awareness.off('change', onChange);
        resolve();
      }
    };
    awareness.on('change', onChange);
  });
}

/** Tries to connect and resolves with the HTTP status the server rejects the connection with. */
function rejectionStatus(pathAndQuery: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}${pathAndQuery}`);
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.on('open', () => {
      socket.close();
      reject(new Error('The connection was accepted'));
    });
    socket.on('error', reject);
  });
}

/** Resolves with the code of the next close of a provider's connection. */
function nextCloseCode(provider: WebsocketProvider): Promise<number | undefined> {
  return new Promise((resolve) => {
    const onClose = (event: { code?: number } | null) => {
      provider.off('connection-close', onClose);
      resolve(event?.code);
    };
    provider.on('connection-close', onClose);
  });
}

/**
 * Records every close of the providers' connections as `name:code`. The test client reconnects
 * after a close, so a connection that is connected later may still have been closed.
 */
function recordCloses(providers: Record<string, WebsocketProvider>): string[] {
  const closes: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    provider.on('connection-close', (event: { code?: number } | null) => {
      closes.push(`${name}:${event?.code}`);
    });
  }
  return closes;
}

/** Sends a notification of the backend, e.g. that a project changed. */
async function notify(path: string, authorization?: string, method = 'POST'): Promise<Response> {
  return fetch(`${httpUrl}${path}`, {
    method,
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

/** The header with a token of the backend's service account. */
const backendToken = async () => `Bearer ${await keycloak.signToken({ roles: [BACKEND_ROLE] })}`;

describe('HTTP', () => {
  it('answers GET /health with 200', async () => {
    const response = await fetch(`${httpUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UP' });
  });

  it('answers other paths with 404', async () => {
    const response = await fetch(`${httpUrl}/unknown`);

    expect(response.status).toBe(404);
  });
});

describe('rooms', () => {
  it('shares changes between owners and members in the same room', async () => {
    const alice = await connect('vsum:1', 'owner');
    const bob = await connect('vsum:1', 'member');

    alice.doc.getMap('test').set('fromOwner', 'Component');
    bob.doc.getMap('test').set('fromMember', 'Interface');

    await expect(valueArrives(bob.doc, 'fromOwner')).resolves.toBe('Component');
    await expect(valueArrives(alice.doc, 'fromMember')).resolves.toBe('Interface');
  });

  it('gives a client that joins later the current state', async () => {
    const alice = await connect('vsum:2', 'owner');
    const bob = await connect('vsum:2', 'member');
    alice.doc.getMap('test').set('name', 'Component');
    await valueArrives(bob.doc, 'name'); // the server has the change by now

    const carol = await connect('vsum:2', 'member');

    expect(carol.doc.getMap('test').get('name')).toBe('Component');
  });

  it('keeps rooms separate', async () => {
    const alice = await connect('vsum:3', 'owner');
    const bob = await connect('vsum:3', 'member');
    const other = await connect('vsum:4', 'owner');

    alice.doc.getMap('test').set('name', 'Component');
    await valueArrives(bob.doc, 'name'); // the server has forwarded the change by now

    expect(other.doc.getMap('test').has('name')).toBe(false);
  });
});

describe('access', () => {
  it('asks the backend for the project of the room with the token of the client', async () => {
    backend.requests.length = 0;

    await connect('vsum:10', 'owner');

    expect(backend.requests).toEqual([
      { path: '/api/v1/vsums/10/details', authorization: 'Bearer owner' },
    ]);
  });

  it('rejects a connection without a token with 401', async () => {
    await expect(rejectionStatus('/vsum:11')).resolves.toBe(401);
    await expect(rejectionStatus('/vsum:11?token=')).resolves.toBe(401);
  });

  it('rejects an invalid token with 401', async () => {
    await expect(rejectionStatus('/vsum:11?token=invalid')).resolves.toBe(401);
  });

  it('rejects a user without access to the project with 403', async () => {
    await expect(rejectionStatus('/vsum:11?token=stranger')).resolves.toBe(403);
  });

  it('rejects a project that does not exist with 403', async () => {
    await expect(rejectionStatus('/vsum:404?token=owner')).resolves.toBe(403);
  });

  it.each(['/', '/vsum', '/vsum:', '/vsum:abc', '/vsum:1a', '/vsum:-1', '/vsum:012', '/vsum:1000000000000000000', '/vsum:1/x', '/room:1', '/%'])(
    'rejects the invalid room name %s with 400 without asking the backend',
    async (path) => {
      backend.requests.length = 0;

      await expect(rejectionStatus(`${path}?token=owner`)).resolves.toBe(400);
      expect(backend.requests).toEqual([]);
    },
  );

  it.each(['broken', 'no-json', 'no-role', 'unknown-role'])(
    'rejects with 503 if the backend fails (%s)',
    async (token) => {
      await expect(rejectionStatus(`/vsum:11?token=${token}`)).resolves.toBe(503);
    },
  );

  it.each(['no-user-id', 'text-user-id', 'fractional-user-id', 'negative-user-id', 'unsafe-user-id'])(
    "rejects with 503 if the backend answers without a valid user ID (%s)",
    async (token) => {
      await expect(rejectionStatus(`/vsum:11?token=${token}`)).resolves.toBe(503);
    },
  );

  it('rejects with 503 if the backend does not answer in time', async () => {
    await expect(rejectionStatus('/vsum:11?token=slow')).resolves.toBe(503);
  });

  it('rejects with 503 if the backend is not reachable', async () => {
    const stopped = await startFakeBackend(answer);
    await stopped.close();
    const lonelyServer = createCollaborationServer({
      backendUrl: stopped.url,
      backend: projects,
      backendTokens,
    });
    const port = await lonelyServer.listen(0);
    try {
      const status = await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://localhost:${port}/vsum:1?token=owner`);
        socket.on('unexpected-response', (_request, response) => resolve(response.statusCode));
        socket.on('error', reject);
      });

      expect(status).toBe(503);
    } finally {
      await lonelyServer.close();
    }
  });

  it('never logs the token', async () => {
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');

    expect(logged).toContain('The backend');
    expect(logged).not.toMatch(/token=|broken|slow|no-json/);
  });
});

describe('viewers', () => {
  it('receive the changes of other users', async () => {
    const owner = await connect('vsum:20', 'owner');
    const viewer = await connect('vsum:20', 'viewer');

    owner.doc.getMap('test').set('name', 'Component');

    await expect(valueArrives(viewer.doc, 'name')).resolves.toBe('Component');
  });

  it('are visible to other users', async () => {
    const owner = await connect('vsum:21', 'owner');
    const viewer = await connect('vsum:21', 'viewer');

    viewer.awareness.setLocalStateField('user', { name: 'Vera' });

    await expect(userAppears(owner, 'Vera')).resolves.toBeUndefined();
  });

  it('cannot change the document', async () => {
    const owner = await connect('vsum:22', 'owner');
    const member = await connect('vsum:22', 'member');
    const viewer = await connect('vsum:22', 'viewer');

    viewer.doc.getMap('test').set('fromViewer', 'Hack');
    // The presence is sent after the change on the same connection, so once it arrived the server
    // has handled the change as well.
    viewer.awareness.setLocalStateField('user', { name: 'Vera' });
    await userAppears(owner, 'Vera');
    owner.doc.getMap('test').set('fromOwner', 'Component');
    await valueArrives(member.doc, 'fromOwner');

    expect(owner.doc.getMap('test').has('fromViewer')).toBe(false);
    expect(member.doc.getMap('test').has('fromViewer')).toBe(false);
    const late = await connect('vsum:22', 'member');
    expect(late.doc.getMap('test').toJSON()).toEqual({ fromOwner: 'Component' });
  });

  it('cannot bring changes along when connecting', async () => {
    const owner = await connect('vsum:23', 'owner');
    const prepared = new Y.Doc();
    prepared.getMap('test').set('fromViewer', 'Hack');

    const viewer = await connect('vsum:23', 'viewer', prepared);
    viewer.awareness.setLocalStateField('user', { name: 'Vera' });
    await userAppears(owner, 'Vera'); // the server has handled the viewer's sync messages by now

    expect(owner.doc.getMap('test').has('fromViewer')).toBe(false);
    const late = await connect('vsum:23', 'member');
    expect(late.doc.getMap('test').has('fromViewer')).toBe(false);
  });
});

/** Resolves once `condition` holds for the client's document, i.e. once a change arrived. */
function arrives(doc: Y.Doc, condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve();
      return;
    }
    const onUpdate = () => {
      if (condition()) {
        doc.off('update', onUpdate);
        resolve();
      }
    };
    doc.on('update', onUpdate);
  });
}

/** The server's document of a room as JSON, `undefined` if the room isn't open. */
function serverDoc(room: string): Record<string, unknown> | undefined {
  return docs.get(room)?.toJSON();
}

/** The name the backend stores for metamodel 1 of a project. */
const storedName = (projectId: string) => projects.projects.get(projectId)?.metaModels[0]?.name;

/** Starts a second server whose writebacks only happen when the last user leaves or on shutdown. */
async function startServerWithoutDelayedWritebacks(): Promise<{
  server: CollaborationServer;
  url: string;
}> {
  const other = createCollaborationServer({
    backendUrl: backend.url,
    backend: projects,
    backendTokens,
    writeback: { ...TIMINGS, debounceMs: 60_000, maxWaitMs: 60_000 },
  });
  return { server: other, url: `ws://localhost:${await other.listen(0)}` };
}

describe('projects', () => {
  it('are loaded when the first user opens them', async () => {
    projects.add('30', {
      metaModels: [
        { id: 101, sourceId: 1, name: 'Car' },
        { id: 102, sourceId: 2, name: 'Brake' },
      ],
      relations: [
        { id: 7, sourceId: 1, targetId: 2, reactionFileStorageId: 50, fineGranularMetaModelRelationSet: [] },
      ],
      views: [{ id: 20, name: 'Overview', description: 'All parts', fileStorageId: 70, metaModelIds: [1] }],
      layout: { metaModels: { '1': { x: 10, y: 20 } } },
    });

    const { doc } = await connect('vsum:30', 'viewer');

    expect(doc.getMap('models').toJSON()).toEqual({
      '1': { name: 'Car', softDeleted: false, softDeletedVia: null },
      '2': { name: 'Brake', softDeleted: false, softDeletedVia: null },
    });
    expect(doc.getMap('relations').toJSON()).toEqual({
      '7': {
        backendId: 7,
        sourceId: 1,
        targetId: 2,
        reactionFileId: 50,
        fineGranular: [],
        softDeleted: false,
        softDeletedVia: null,
      },
    });
    expect(doc.getMap('views').toJSON()).toEqual({
      '20': {
        backendId: 20,
        name: 'Overview',
        description: 'All parts',
        fileStorageId: 70,
        metaModelIds: [1],
        softDeleted: false,
        softDeletedVia: null,
      },
    });
    expect(doc.getMap('layout').toJSON()).toEqual({ metaModels: { '1': { x: 10, y: 20 } }, reactions: {} });
  });

  it('get the changes of users written back after a short delay', async () => {
    projects.add('31', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const { doc } = await connect('vsum:31', 'member');

    (doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Vehicle');

    await vi.waitFor(() => expect(storedName('31')).toBe('Vehicle'));
  });

  it('create a new view once, and every user gets its backend ID', async () => {
    projects.add('32', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const alice = await connect('vsum:32', 'owner');
    const bob = await connect('vsum:32', 'member');
    const view = new Y.Map<unknown>(
      Object.entries({
        backendId: null,
        name: 'Overview',
        description: new Y.Text('All parts'),
        fileStorageId: 70,
        metaModelIds: [1],
        softDeleted: false,
        softDeletedVia: null,
      }),
    );

    alice.doc.getMap('views').set('3f1c-new', view);

    const backendIdAtBob = () =>
      (bob.doc.getMap('views').get('3f1c-new') as Y.Map<unknown> | undefined)?.get('backendId');
    await arrives(bob.doc, () => backendIdAtBob() === 1000);
    (alice.doc.getMap('views').get('3f1c-new') as Y.Map<unknown>).set('name', 'All parts');
    await vi.waitFor(() =>
      expect(projects.projects.get('32')?.views).toMatchObject([{ id: 1000, name: 'All parts' }]),
    );
    expect(projects.changes.filter((change) => change.includes('view'))).toEqual([
      'create view 1000',
      'update view 1000',
    ]);
  });

  it('report a rejected writeback to every user in status', async () => {
    projects.add('33', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    projects.nextSyncs.push(new BackendError(400, 'status 400', 'View names must be unique'));
    const alice = await connect('vsum:33', 'owner');
    const viewer = await connect('vsum:33', 'viewer');

    (alice.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Vehicle');

    const error = () => viewer.doc.getMap('status').get('writebackError');
    await arrives(viewer.doc, () => typeof error() === 'string');
    expect(error()).toBe('The changes could not be saved: View names must be unique');
  });

  it("are not written back for a viewer's attempted change", async () => {
    projects.add('34', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const viewer = await connect('vsum:34', 'viewer');

    (viewer.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Hack');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(projects.requests.filter((request) => request.projectId === '34')).toEqual([]);
  });

  it('are written back when the last user leaves', async () => {
    projects.add('35', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const other = await startServerWithoutDelayedWritebacks();
    try {
      const provider = await connect('vsum:35', 'owner', new Y.Doc(), other.url);
      (provider.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Vehicle');
      await vi.waitFor(() => expect(JSON.stringify(serverDoc('vsum:35'))).toContain('Vehicle'));
      expect(storedName('35')).toBe('Car');

      provider.destroy();

      await vi.waitFor(() => expect(storedName('35')).toBe('Vehicle'));
      await vi.waitFor(() => expect(docs.has('vsum:35')).toBe(false));
    } finally {
      await other.server.close();
    }
  });

  it('are written back when the server shuts down', async () => {
    projects.add('36', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const other = await startServerWithoutDelayedWritebacks();
    const provider = await connect('vsum:36', 'owner', new Y.Doc(), other.url);
    (provider.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Vehicle');
    await vi.waitFor(() => expect(JSON.stringify(serverDoc('vsum:36'))).toContain('Vehicle'));

    await other.server.close();
    provider.destroy();

    expect(storedName('36')).toBe('Vehicle');
    expect(docs.has('vsum:36')).toBe(false);
  });

  it('are not opened, and never written back, if loading fails', async () => {
    projects.nextLoads.push(new BackendError(500, 'status 500'));

    await expect(rejectionStatus('/vsum:37?token=owner')).resolves.toBe(503);

    expect(docs.has('vsum:37')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(projects.requests.filter((request) => request.projectId === '37')).toEqual([]);
  });

  it('that the backend does not have are rejected with 403', async () => {
    projects.missing.add('38');

    await expect(rejectionStatus('/vsum:38?token=owner')).resolves.toBe(403);
  });

  it('are closed again when the only client went away while they were loading', async () => {
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const socket = connectTcp(Number(new URL(wsUrl).port), 'localhost');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(
      'GET /vsum:39?token=owner HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    await vi.waitFor(() => expect(projects.loads).toContain('39'));

    // Only half-closes the connection, so the server's socket isn't destroyed yet.
    socket.end();
    loading.open();

    await vi.waitFor(() => expect(docs.has('vsum:39')).toBe(false));
    socket.destroy();
  });
});

describe('robustness', () => {
  it('survives a malformed frame and logs it without the token', async () => {
    projects.add('50', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const socket = new WebSocket(`${wsUrl}/vsum:50?token=owner`);
    await new Promise((resolve) => socket.once('open', resolve));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.on('error', () => {});

    // A frame with RSV1 set, which ws rejects as invalid.
    (socket as unknown as { _socket: { write(data: Buffer): void } })._socket.write(
      Buffer.from([0xc2, 0x80, 1, 2, 3, 4]),
    );
    await closed;

    expect((await fetch(`${httpUrl}/health`)).status).toBe(200);
    const logged = vi.mocked(console.error).mock.calls.map((call) => call.join(' '));
    expect(logged.some((line) => line.startsWith('A connection to vsum:50 failed:'))).toBe(true);
    expect(logged.join(' ')).not.toContain('token=');
  });

  it('closes a connection that sends a message larger than 16 MiB', async () => {
    projects.add('56', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const socket = new WebSocket(`${wsUrl}/vsum:56?token=owner`);
    await new Promise((resolve) => socket.once('open', resolve));
    socket.on('error', () => {});
    const code = new Promise((resolve) => socket.once('close', resolve));

    socket.send(Buffer.alloc(MAX_MESSAGE_BYTES + 1));

    await expect(code).resolves.toBe(1009); // message too big
    expect((await fetch(`${httpUrl}/health`)).status).toBe(200);
  });

  it('closes a room again when its only client reset the connection while it was loading', async () => {
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const socket = connectTcp(Number(new URL(wsUrl).port), 'localhost');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(
      'GET /vsum:51?token=owner HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    await vi.waitFor(() => expect(projects.loads).toContain('51'));

    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50)); // the server notices the reset
    loading.open();

    await vi.waitFor(() => expect(docs.has('vsum:51')).toBe(false));
  });

  it('rejects a connection that completes its request while the server shuts down, without asking the backend', async () => {
    const other = createCollaborationServer({
      backendUrl: backend.url,
      backend: projects,
      backendTokens,
      writeback: TIMINGS,
      shutdownTimeoutMs: 1000,
    });
    const port = await other.listen(0);
    // A connection whose project is still loading keeps the server busy shutting down.
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const pending = new WebSocket(`ws://localhost:${port}/vsum:52?token=owner`);
    pending.on('error', () => {});
    await vi.waitFor(() => expect(projects.loads).toContain('52'));
    const socket = connectTcp(port, 'localhost');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const response = new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
    });
    socket.write('GET /vsum:53?token=owner HTTP/1.1\r\nHost: localhost\r\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    backend.requests.length = 0;

    const closed = other.close();
    socket.write(
      'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );

    expect(await response).toMatch(/^HTTP\/1\.1 503 /);
    expect(backend.requests).toEqual([]);
    loading.open();
    await closed;
  });

  it('waits for the first shutdown when it is asked to shut down again', async () => {
    projects.add('54', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const other = await startServerWithoutDelayedWritebacks();
    const provider = await connect('vsum:54', 'owner', new Y.Doc(), other.url);
    (provider.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Vehicle');
    await vi.waitFor(() => expect(JSON.stringify(serverDoc('vsum:54'))).toContain('Vehicle'));
    const saving = gate();
    projects.nextSyncs.push(saving.interruption);

    const first = other.server.close();
    const second = other.server.close();
    saving.open();

    expect(second).toBe(first);
    await second;
    provider.destroy();
    expect(storedName('54')).toBe('Vehicle');
  });

  it("doesn't let y-websocket store documents, even if a persistence was set", async () => {
    const bindState = vi.fn();
    setPersistence({ provider: null, bindState, writeState: async () => {} } as never);
    const other = createCollaborationServer({
      backendUrl: backend.url,
      backend: projects,
      backendTokens,
      writeback: TIMINGS,
    });
    try {
      const url = `ws://localhost:${await other.listen(0)}`;
      projects.add('55', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });

      await connect('vsum:55', 'owner', new Y.Doc(), url);

      expect(bindState).not.toHaveBeenCalled();
    } finally {
      setPersistence(null);
      await other.close();
    }
  });
});

describe('room names', () => {
  it.each(['0', '999999999999999999'])('accepts vsum:%s', async (id) => {
    backend.requests.length = 0;

    await connect(`vsum:${id}`, 'owner');

    expect(backend.requests).toEqual([
      { path: `/api/v1/vsums/${id}/details`, authorization: 'Bearer owner' },
    ]);
  });
});

describe('outdated documents', () => {
  const epochOf = (doc: Y.Doc) => String(doc.getMap('status').get('epoch'));
  const model = (doc: Y.Doc, key: string) => doc.getMap('models').get(key) as Y.Map<unknown> | undefined;

  /** Disconnects a client, keeping its document, like a laptop going to sleep. */
  function sleep(provider: WebsocketProvider): void {
    provider.disconnect();
  }

  it("are closed with 4409 after their room was created again, and don't bring deleted models back", async () => {
    projects.add('80', {
      metaModels: [
        { id: 101, sourceId: 1, name: 'A' },
        { id: 102, sourceId: 2, name: 'B' },
      ],
    });
    // Alice's laptop goes to sleep with model A on the canvas.
    const alice = await connect('vsum:80', 'owner');
    const aliceEpoch = epochOf(alice.doc);
    sleep(alice);
    await vi.waitFor(() => expect(docs.has('vsum:80')).toBe(false));
    // Bob deletes A, the deletion is written back, and Bob leaves.
    const bob = await connect('vsum:80', 'member');
    model(bob.doc, '1')?.set('softDeleted', true);
    await vi.waitFor(() => expect(projects.projects.get('80')?.metaModels.map((m) => m.sourceId)).toEqual([2]));
    bob.destroy();
    await vi.waitFor(() => expect(docs.has('vsum:80')).toBe(false));
    const loads = projects.loads.length;

    // Alice's laptop wakes up and her tab reconnects with its old document.
    alice.params.epoch = aliceEpoch;
    const closed = nextCloseCode(alice);
    alice.connect();

    expect(await closed).toBe(4409);
    alice.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(projects.projects.get('80')?.metaModels.map((m) => m.sourceId)).toEqual([2]);
    expect(projects.loads).toHaveLength(loads); // no room was created for her
    expect(docs.has('vsum:80')).toBe(false);
  });

  it('are closed with 4409 while the project has a newer room, which keeps its state', async () => {
    projects.add('81', { metaModels: [{ id: 101, sourceId: 1, name: 'A' }] });
    const alice = await connect('vsum:81', 'owner');
    const aliceEpoch = epochOf(alice.doc);
    sleep(alice);
    await vi.waitFor(() => expect(docs.has('vsum:81')).toBe(false));
    const carol = await connect('vsum:81', 'member');
    model(alice.doc, '1')?.set('name', 'Outdated name');

    alice.params.epoch = aliceEpoch;
    const closed = nextCloseCode(alice);
    alice.connect();

    expect(await closed).toBe(4409);
    alice.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(model(carol.doc, '1')?.get('name')).toBe('A');
    expect(epochOf(carol.doc)).not.toBe(aliceEpoch);
  });

  it('keep the edits made offline if their room still exists', async () => {
    projects.add('82', { metaModels: [{ id: 101, sourceId: 1, name: 'A' }] });
    const alice = await connect('vsum:82', 'owner');
    const bob = await connect('vsum:82', 'member');
    sleep(alice);
    model(alice.doc, '1')?.set('name', 'Renamed offline');

    alice.params.epoch = epochOf(alice.doc);
    alice.connect();

    await vi.waitFor(() => expect(model(bob.doc, '1')?.get('name')).toBe('Renamed offline'));
    await vi.waitFor(() => expect(projects.projects.get('82')?.metaModels[0].name).toBe('Renamed offline'));
  });

  it('are only checked after the access check', async () => {
    projects.add('83');
    await connect('vsum:83', 'owner');

    await expect(rejectionStatus('/vsum:83?token=stranger&epoch=outdated')).resolves.toBe(403);
    await expect(rejectionStatus('/vsum:84?token=invalid&epoch=outdated')).resolves.toBe(401);
  });

  it('are recognized by any epoch that is not the room\'s, also for a project without room', async () => {
    projects.add('85');
    await connect('vsum:85', 'owner');

    for (const room of ['vsum:85', 'vsum:86']) {
      const code = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${wsUrl}/${room}?token=owner&epoch=not-the-epoch`);
        socket.on('close', (closeCode) => resolve(closeCode));
        socket.on('error', reject);
      });

      expect(code).toBe(4409);
    }
    expect(projects.loads).not.toContain('86');
  });

  it('survive an invalid frame sent before the connection is closed', async () => {
    const socket = new WebSocket(`${wsUrl}/vsum:88?token=owner&epoch=outdated`);
    socket.on('error', () => {});
    const closed = new Promise((resolve) => socket.once('close', resolve));
    // Right on open, before the client answers the server's close.
    socket.once('open', () => {
      // A frame with RSV1 set, which ws rejects as invalid.
      (socket as unknown as { _socket: { write(data: Buffer): void } })._socket.write(
        Buffer.from([0xc2, 0x80, 1, 2, 3, 4]),
      );
    });
    await closed;

    expect((await fetch(`${httpUrl}/health`)).status).toBe(200);
    const logged = vi.mocked(console.error).mock.calls.map((call) => call.join(' '));
    expect(logged.some((line) => line.startsWith('A connection to vsum:88 failed:'))).toBe(true);
  });

  it('do not include an empty document: a client without epoch joins as before', async () => {
    projects.add('87', { metaModels: [{ id: 101, sourceId: 1, name: 'A' }] });

    const fresh = await connect('vsum:87', 'owner', new Y.Doc(), wsUrl, { epoch: '' });

    expect(model(fresh.doc, '1')?.get('name')).toBe('A');
  });
});

describe('reload notifications', () => {
  /** Sends a request line as it is, without a client that would correct it; returns the status. */
  function rawStatus(requestLine: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = connectTcp(Number(new URL(httpUrl).port), 'localhost', () => {
        socket.end(`${requestLine}\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`);
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
      socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(received)?.[1])));
      socket.on('error', reject);
    });
  }

  const accessChecks = () => backend.requests.length;

  it('bring a change made outside the document to connected clients, without reconnecting', async () => {
    projects.add('70', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const client = await connect('vsum:70', 'owner');
    const models = client.doc.getMap('models');
    const checks = accessChecks();
    projects.projects.get('70')!.metaModels[0].name = 'Vehicle';

    const response = await notify('/internal/projects/70/reload', await backendToken());

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect((models.get('1') as Y.Map<unknown>).get('name')).toBe('Vehicle'));
    expect(accessChecks()).toBe(checks);
    expect(client.wsconnected).toBe(true);
  });

  it('keep the epoch of the room, so a client that reconnects afterwards is not closed as outdated', async () => {
    projects.add('72', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const alice = await connect('vsum:72', 'owner');
    const bob = await connect('vsum:72', 'member'); // keeps the room open
    const epoch = String(alice.doc.getMap('status').get('epoch'));
    const nameIn = (doc: Y.Doc) => (doc.getMap('models').get('1') as Y.Map<unknown>).get('name');
    alice.disconnect();
    projects.projects.get('72')!.metaModels[0].name = 'Vehicle';

    await notify('/internal/projects/72/reload', await backendToken());
    await vi.waitFor(() => expect(nameIn(bob.doc)).toBe('Vehicle'));
    alice.params.epoch = epoch;
    alice.connect();

    await vi.waitFor(() => expect(nameIn(alice.doc)).toBe('Vehicle'));
    expect(alice.wsconnected).toBe(true);
    expect(String(bob.doc.getMap('status').get('epoch'))).toBe(epoch);
  });

  it('do nothing for a project nobody has open', async () => {
    const loads = projects.loads.length;

    const response = await notify('/internal/projects/71/reload', await backendToken());

    expect(response.status).toBe(202);
    expect(projects.loads).toHaveLength(loads);
  });

  it.each([
    ['without token', undefined],
    ['with an invalid token', 'Bearer not-a-token'],
  ])('are rejected with 401 %s', async (_name, authorization) => {
    const response = await notify('/internal/projects/70/reload', authorization);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('are rejected with 401 if the token is forged or expired', async () => {
    for (const options of [{ forged: true }, { expiresIn: -60 }]) {
      const token = await keycloak.signToken({ roles: [BACKEND_ROLE], ...options });

      expect((await notify('/internal/projects/70/reload', `Bearer ${token}`)).status).toBe(401);
    }
  });

  it("are rejected with 403 if the token lacks the backend's role", async () => {
    const userToken = await keycloak.signToken({ roles: ['user'] });

    const response = await notify('/internal/projects/70/reload', `Bearer ${userToken}`);

    expect(response.status).toBe(403);
  });

  it.each(['abc', '012', '-1', '1234567890123456789'])(
    'are rejected with 400 for the invalid project ID %s',
    async (id) => {
      expect((await notify(`/internal/projects/${id}/reload`, await backendToken())).status).toBe(400);
    },
  );

  it('survive malformed paths', async () => {
    expect((await notify('/internal/projects/%/reload', await backendToken())).status).toBe(400);
    expect(await rawStatus('POST http://[bad/internal/projects/1/reload HTTP/1.1')).toBe(400);
    expect((await fetch(`${httpUrl}/health`)).status).toBe(200);
  });

  it('check the token before the project ID', async () => {
    expect((await notify('/internal/projects/abc/reload')).status).toBe(401);
  });

  it('only accept POST', async () => {
    const response = await notify('/internal/projects/70/reload', await backendToken(), 'GET');

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('are unknown on other paths', async () => {
    for (const path of [
      '/internal/projects/70',
      '/internal/projects/70/reload/x',
      '/internal',
      '/internal/projects/70/check',
      '/internal/users/1/close',
      '/internal/users/1/reload',
      '/internal/users/1',
      '/internal/users/1/check-access/x',
    ]) {
      expect((await notify(path, await backendToken())).status).toBe(404);
    }
  });

  it('never log the token', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE], forged: true });
    await notify('/internal/projects/70/reload', `Bearer ${token}`);

    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toContain('Rejected a reload notification');
    expect(logged).not.toContain(token);
  });
});

describe('close notifications', () => {
  it('close the connections of a removed project with 4410 and drop its room without writing it back', async () => {
    projects.add('60', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    projects.add('61');
    const alice = await connect('vsum:60', 'owner');
    const bob = await connect('vsum:60', 'viewer');
    const carol = await connect('vsum:61', 'owner'); // another project
    const closes = [nextCloseCode(alice), nextCloseCode(bob)];
    // The project is in the trash now: loading it or writing it back fails with 404.
    projects.missing.add('60');
    (alice.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Not saved yet');

    const response = await notify('/internal/projects/60/close', await backendToken());
    // A writeback that started before the close is allowed; none may start afterwards.
    const requests = projects.requests.length;

    expect(response.status).toBe(202);
    expect(await Promise.all(closes)).toEqual([4410, 4410]);
    alice.disconnect();
    bob.disconnect();
    expect(docs.has('vsum:60')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300)); // longer than the writeback delays
    expect(projects.requests.slice(requests).filter((request) => request.projectId === '60')).toEqual([]);
    expect(carol.wsconnected).toBe(true);
    expect(docs.has('vsum:61')).toBe(true);
  });

  it('drop what a client sends while the connection is closing, and terminate it if it never completes the close', async () => {
    projects.add('67');
    const owner = await connect('vsum:67', 'owner');
    const doc = docs.get('vsum:67') as WSSharedDoc; // kept: the room is dropped from `docs`
    const socket = stopReading(owner);
    projects.missing.add('67');

    expect((await notify('/internal/projects/67/close', await backendToken())).status).toBe(202);
    // The client hasn't read the server's close, so it still sends its changes.
    owner.doc.getMap('test').set('afterRemoval', 'Hack');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(doc.getMap('test').has('afterRemoval')).toBe(false);
    // ws itself would wait 30 seconds before it gives up on the close.
    await vi.waitFor(() => expect(doc.conns.size).toBe(0), { timeout: 2000 });
    socket.resume();
    owner.disconnect();
  });

  it('are ignored for a project the backend still has, e.g. one restored before a late notification', async () => {
    projects.add('65', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const alice = await connect('vsum:65', 'owner');
    const doc = docs.get('vsum:65');

    const response = await notify('/internal/projects/65/close', await backendToken());
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(response.status).toBe(202);
    expect(alice.wsconnected).toBe(true);
    expect(docs.get('vsum:65')).toBe(doc);
  });

  it('are answered with 503 and keep the room if the backend cannot confirm the removal', async () => {
    projects.add('66');
    const alice = await connect('vsum:66', 'owner');
    projects.nextLoads.push(new BackendError(503, 'The backend answered GET with status 503'));

    const response = await notify('/internal/projects/66/close', await backendToken());

    expect(response.status).toBe(503);
    expect(alice.wsconnected).toBe(true);
    expect(docs.has('vsum:66')).toBe(true);
  });

  it('reject a connection whose project was still loading with 403', async () => {
    projects.add('62');
    const loading = gate();
    // The connection's load waits; the check whether the project is gone answers 404.
    projects.nextLoads.push(loading.interruption, new BackendError(404, 'status 404'));
    const rejected = rejectionStatus('/vsum:62?token=owner');
    await vi.waitFor(() => expect(projects.loads).toContain('62'));

    await notify('/internal/projects/62/close', await backendToken());
    loading.open();

    expect(await rejected).toBe(403);
    expect(docs.has('vsum:62')).toBe(false);
  });

  it('let users open the project again once it was restored, in a new room', async () => {
    projects.add('63', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const alice = await connect('vsum:63', 'owner');
    const epoch = String(alice.doc.getMap('status').get('epoch'));
    const closed = nextCloseCode(alice);
    projects.missing.add('63');
    await notify('/internal/projects/63/close', await backendToken());
    await closed;
    alice.disconnect();
    projects.missing.delete('63'); // restored

    const bob = await connect('vsum:63', 'member');

    expect(String(bob.doc.getMap('status').get('epoch'))).not.toBe(epoch);
    expect((bob.doc.getMap('models').get('1') as Y.Map<unknown>).get('name')).toBe('Car');
  });

  it('do nothing for a project nobody has open', async () => {
    const loads = projects.loads.length;

    const response = await notify('/internal/projects/64/close', await backendToken());

    expect(response.status).toBe(202);
    expect(projects.loads).toHaveLength(loads);
  });

  it('are rejected like reload notifications if the token or the project ID is invalid', async () => {
    const userToken = `Bearer ${await keycloak.signToken({ roles: ['user'] })}`;

    expect((await notify('/internal/projects/60/close')).status).toBe(401);
    expect((await notify('/internal/projects/60/close', userToken)).status).toBe(403);
    expect((await notify('/internal/projects/abc/close', await backendToken())).status).toBe(400);
    expect((await notify('/internal/projects/60/close', await backendToken(), 'GET')).status).toBe(405);
  });

  it('never log the token', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE], forged: true });
    await notify('/internal/projects/60/close', `Bearer ${token}`);

    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toContain('Rejected a close notification');
    expect(logged).not.toContain(token);
  });
});

/** Resolves once `provider` no longer sees a user with the given name, i.e. once that presence was removed. */
function userLeaves(provider: WebsocketProvider, name: string): Promise<void> {
  const awareness = provider.awareness;
  const isThere = () =>
    [...awareness.getStates().values()].some((state) => state.user?.name === name);
  return new Promise((resolve) => {
    if (!isThere()) {
      resolve();
      return;
    }
    const onChange = () => {
      if (!isThere()) {
        awareness.off('change', onChange);
        resolve();
      }
    };
    awareness.on('change', onChange);
  });
}

/**
 * Stops reading the provider's connection, like a client that never answers the server's close.
 * The provider doesn't notice the close then, so it keeps sending its changes.
 */
function stopReading(provider: WebsocketProvider): WebSocket {
  const socket = provider.ws as unknown as WebSocket;
  socket.pause();
  return socket;
}

/**
 * Opens a connection without a provider and resolves with the code it is closed with. Messages it
 * receives are added to `messages`.
 */
function openRaw(pathAndQuery: string, messages: unknown[] = []): Promise<number> {
  const socket = new WebSocket(`${wsUrl}${pathAndQuery}`);
  socket.on('message', (message) => messages.push(message));
  // A rejected handshake is reported as an error and then closes with 1006.
  socket.on('error', () => {});
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

/** Number of times the fake backend was asked for the user's access to a project. */
const accessRequests = (projectId: string) =>
  backend.requests.filter((request) => request.path === `/api/v1/vsums/${projectId}/details`).length;

describe('check-access notifications (project)', () => {
  const checkAccess = async (projectId: string) =>
    notify(`/internal/projects/${projectId}/check-access`, await backendToken());

  it('close every connection of a removed member with 4403 and leave the other users alone', async () => {
    projects.add('100');
    projects.add('101');
    const owner = await connect('vsum:100', 'owner');
    const member2 = await connect('vsum:100', 'member2');
    const viewer = await connect('vsum:100', 'viewer');
    const tab = await connect('vsum:100', 'member');
    const otherTab = await connect('vsum:100', 'member-renewed'); // same user, another token
    const elsewhere = await connect('vsum:101', 'member'); // the same user in another project
    const closes = [nextCloseCode(tab), nextCloseCode(otherTab)];
    const otherCloses = recordCloses({ owner, member2, viewer, elsewhere });
    projects.membersOf('100').delete(USERS.member);

    const response = await checkAccess('100');

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('Checked');
    expect(await Promise.all(closes)).toEqual([4403, 4403]);
    tab.disconnect();
    otherTab.disconnect();
    owner.doc.getMap('test').set('fromOwner', 'Component');
    member2.doc.getMap('test').set('fromMember', 'Interface');
    await expect(valueArrives(member2.doc, 'fromOwner')).resolves.toBe('Component');
    await expect(valueArrives(owner.doc, 'fromMember')).resolves.toBe('Interface');
    await expect(valueArrives(viewer.doc, 'fromMember')).resolves.toBe('Interface');
    expect(elsewhere.wsconnected).toBe(true);
    expect(otherCloses).toEqual([]);
    expect(console.log).toHaveBeenCalledWith('Closed 2 connection(s) of user 2 to vsum:100: access revoked');
    await expect(rejectionStatus('/vsum:100?token=member')).resolves.toBe(403);
  });

  it('close the connection of a removed viewer with 4403, so it receives nothing anymore', async () => {
    const owner = await connect('vsum:102', 'owner');
    const viewer = await connect('vsum:102', 'viewer');
    const closed = nextCloseCode(viewer);
    projects.membersOf('102').delete(USERS.viewer);

    expect((await checkAccess('102')).status).toBe(202);

    expect(await closed).toBe(4403);
    viewer.disconnect();
    expect(owner.wsconnected).toBe(true);
  });

  it('drop the changes a removed member sends while the connection is closing', async () => {
    projects.add('103', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const owner = await connect('vsum:103', 'owner');
    const member = await connect('vsum:103', 'member');
    const socket = stopReading(member);
    projects.membersOf('103').delete(USERS.member);
    const before = serverDoc('vsum:103');

    expect((await checkAccess('103')).status).toBe(202);
    // The client hasn't read the server's close, so it still sends its changes.
    member.doc.getMap('test').set('afterRemoval', 'Hack');
    (member.doc.getMap('models').get('1') as Y.Map<unknown>).set('name', 'Hack');
    await new Promise((resolve) => setTimeout(resolve, 300)); // longer than the writeback delays

    expect(serverDoc('vsum:103')).toEqual(before);
    expect(owner.doc.getMap('test').has('afterRemoval')).toBe(false);
    expect(projects.requests.filter((request) => request.projectId === '103')).toEqual([]);
    const closed = nextCloseCode(member);
    socket.resume();
    expect(await closed).toBe(4403);
    member.disconnect();
  });

  it('drop the presence a removed member sends while the connection is closing', async () => {
    const owner = await connect('vsum:115', 'owner');
    const member = await connect('vsum:115', 'member');
    const socket = stopReading(member);
    projects.membersOf('115').delete(USERS.member);
    // A presence forwarded to the owner may be removed again right away, so every one is recorded.
    const seen: unknown[] = [];
    owner.awareness.on('change', () => {
      for (const state of owner.awareness.getStates().values()) {
        if (String(state.user?.name).startsWith('Ghost')) {
          seen.push(state.user.name);
        }
      }
    });

    expect((await checkAccess('115')).status).toBe(202);
    // The client hasn't read the server's close, so it still sends its presence. Both are sent
    // well before the connection is terminated.
    member.awareness.setLocalStateField('user', { name: 'Ghost' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    member.awareness.setLocalStateField('user', { name: 'Ghost 2' });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(seen).toEqual([]);
    const closed = nextCloseCode(member);
    socket.resume();
    expect(await closed).toBe(4403);
    member.disconnect();
  });

  it('terminate a connection whose client never completes the close, which removes its presence', async () => {
    const owner = await connect('vsum:104', 'owner');
    const member = await connect('vsum:104', 'member');
    member.awareness.setLocalStateField('user', { name: 'Mia' });
    await userAppears(owner, 'Mia');
    stopReading(member);
    projects.membersOf('104').delete(USERS.member);

    expect((await checkAccess('104')).status).toBe(202);

    // ws itself would wait 30 seconds, longer than the test may take.
    await expect(userLeaves(owner, 'Mia')).resolves.toBeUndefined();
  });

  it('close the connection of a member who may now only view the project with 4412; the next one is read-only', async () => {
    const owner = await connect('vsum:105', 'owner');
    const member = await connect('vsum:105', 'member');
    const closed = nextCloseCode(member);
    projects.membersOf('105').set(USERS.member, 'VIEWER');

    expect((await checkAccess('105')).status).toBe(202);

    expect(await closed).toBe(4412);
    member.destroy();
    expect(console.log).toHaveBeenCalledWith('Closed 1 connection(s) of user 2 to vsum:105: role changed');
    const again = await connect('vsum:105', 'member');
    again.doc.getMap('test').set('fromViewer', 'Hack');
    // The presence is sent after the change on the same connection, so once it arrived the server
    // has handled the change as well.
    again.awareness.setLocalStateField('user', { name: 'Max' });
    await userAppears(owner, 'Max');
    expect(docs.get('vsum:105')?.getMap('test').has('fromViewer')).toBe(false);
  });

  it('keep the connection of a viewer who may now edit, which stays read-only until it reconnects', async () => {
    const owner = await connect('vsum:106', 'owner');
    const viewer = await connect('vsum:106', 'viewer');
    const closes = recordCloses({ viewer });
    projects.membersOf('106').set(USERS.viewer, 'MEMBER');

    expect((await checkAccess('106')).status).toBe(202);

    viewer.doc.getMap('test').set('fromViewer', 'Hack');
    viewer.awareness.setLocalStateField('user', { name: 'Vera' });
    await userAppears(owner, 'Vera'); // the server has handled the change by now
    expect(viewer.wsconnected).toBe(true);
    expect(closes).toEqual([]);
    expect(owner.doc.getMap('test').has('fromViewer')).toBe(false);
  });

  it('keep the connections of an owner and a member whose roles were swapped', async () => {
    const owner = await connect('vsum:112', 'owner');
    const member = await connect('vsum:112', 'member');
    const closes = recordCloses({ owner, member });
    projects.membersOf('112').set(USERS.owner, 'MEMBER').set(USERS.member, 'OWNER');

    expect((await checkAccess('112')).status).toBe(202);

    member.doc.getMap('test').set('fromMember', 'Interface');
    await expect(valueArrives(owner.doc, 'fromMember')).resolves.toBe('Interface');
    expect(owner.wsconnected && member.wsconnected).toBe(true);
    expect(closes).toEqual([]);
  });

  it('close nothing if the notification arrives after the member was added again with the same role', async () => {
    const owner = await connect('vsum:107', 'owner');
    const member = await connect('vsum:107', 'member');
    const closes = recordCloses({ owner, member });
    projects.membersOf('107').delete(USERS.member);
    projects.membersOf('107').set(USERS.member, 'MEMBER');

    expect((await checkAccess('107')).status).toBe(202);

    member.doc.getMap('test').set('fromMember', 'Interface');
    await expect(valueArrives(owner.doc, 'fromMember')).resolves.toBe('Interface');
    expect(member.wsconnected).toBe(true);
    expect(closes).toEqual([]);
  });

  it('are answered with 503 and close nothing if the members cannot be loaded; the repeated notification closes', async () => {
    const owner = await connect('vsum:108', 'owner');
    const member = await connect('vsum:108', 'member');
    projects.membersOf('108').delete(USERS.member);
    projects.nextMemberLoads.push(new BackendError(503, 'The backend answered GET with status 503'));

    expect((await checkAccess('108')).status).toBe(503);
    member.doc.getMap('test').set('fromMember', 'Interface');
    await expect(valueArrives(owner.doc, 'fromMember')).resolves.toBe('Interface');
    const closed = nextCloseCode(member);

    expect((await checkAccess('108')).status).toBe(202);
    expect(await closed).toBe(4403);
    member.disconnect();
  });

  it('skip connections that were closed while the members were loading', async () => {
    const owner = await connect('vsum:113', 'owner');
    const member = await connect('vsum:113', 'member');
    member.awareness.setLocalStateField('user', { name: 'Mia' });
    await userAppears(owner, 'Mia');
    projects.membersOf('113').delete(USERS.member);
    const loading = gate();
    projects.nextMemberLoads.push(loading.interruption);
    const response = checkAccess('113');
    await vi.waitFor(() => expect(projects.memberLoads).toContain('113'));

    member.disconnect();
    await userLeaves(owner, 'Mia'); // the server handled the close
    loading.open();

    expect((await response).status).toBe(202);
    const logged = vi.mocked(console.log).mock.calls.flat().join(' ');
    expect(logged).not.toContain('vsum:113');
  });

  it('compare only connections accepted before the members were asked for', async () => {
    const owner = await connect('vsum:114', 'owner');
    const oldTab = await connect('vsum:114', 'member');
    const oldClosed = nextCloseCode(oldTab);
    projects.membersOf('114').delete(USERS.member);
    const loading = gate();
    projects.nextMemberLoads.push(loading.interruption);
    const response = checkAccess('114');
    await vi.waitFor(() => expect(projects.memberLoads).toContain('114'));
    projects.membersOf('114').set(USERS.member, 'MEMBER'); // added again, after the answer
    const newTab = await connect('vsum:114', 'member');
    const closes = recordCloses({ newTab });

    loading.open();

    expect((await response).status).toBe(202);
    expect(await oldClosed).toBe(4403);
    oldTab.disconnect();
    newTab.doc.getMap('test').set('fromNewTab', 'Interface');
    await expect(valueArrives(owner.doc, 'fromNewTab')).resolves.toBe('Interface');
    expect(newTab.wsconnected).toBe(true);
    expect(closes).toEqual([]);
  });

  it('do nothing, without asking the backend, for a project nobody has open', async () => {
    const memberLoads = projects.memberLoads.length;

    const response = await checkAccess('109');

    expect(response.status).toBe(202);
    expect(projects.memberLoads).toHaveLength(memberLoads);
  });

  it('close the room with 4410 if the backend no longer has the project, once that is confirmed', async () => {
    projects.add('110');
    const owner = await connect('vsum:110', 'owner');
    const closed = nextCloseCode(owner);
    // In the trash: the members and the project answer 404.
    projects.missing.add('110');

    expect((await checkAccess('110')).status).toBe(202);

    expect(await closed).toBe(4410);
    owner.disconnect();
    expect(docs.has('vsum:110')).toBe(false);
  });

  it('leave the room alone if the members answer 404 but the backend still has the project', async () => {
    projects.add('111');
    const owner = await connect('vsum:111', 'owner');
    const doc = docs.get('vsum:111');
    projects.nextMemberLoads.push(new BackendError(404, 'The backend answered GET with status 404'));
    const loads = projects.loads.length;

    const response = await checkAccess('111');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(response.status).toBe(202);
    expect(projects.loads.slice(loads)).toEqual(['111']); // the removal was not confirmed
    expect(owner.wsconnected).toBe(true);
    expect(docs.get('vsum:111')).toBe(doc);
  });

  it('accept a connection whose user was removed while it was loading, and close it with 4403 before it gets anything', async () => {
    projects.add('120', { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const messages: unknown[] = [];
    const closed = openRaw('/vsum:120?token=member', messages);
    await vi.waitFor(() => expect(projects.loads).toContain('120'));
    projects.membersOf('120').delete(USERS.member);

    expect((await checkAccess('120')).status).toBe(202);
    loading.open();

    expect(await closed).toBe(4403); // not a rejected handshake (1006)
    expect(messages).toEqual([]);
    expect(accessRequests('120')).toBe(2);
    await vi.waitFor(() => expect(docs.has('vsum:120')).toBe(false)); // its join was released
  });

  it('accept a connection whose user is still a member after asking for the access again', async () => {
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const connecting = connect('vsum:121', 'member');
    await vi.waitFor(() => expect(projects.loads).toContain('121'));

    expect((await checkAccess('121')).status).toBe(202);
    loading.open();

    const member = await connecting;
    expect(member.wsconnected).toBe(true);
    expect(accessRequests('121')).toBe(2);
  });

  it('use the role asked for again for a connection whose role was lowered while it was loading', async () => {
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const connecting = connect('vsum:123', 'member');
    await vi.waitFor(() => expect(projects.loads).toContain('123'));
    projects.membersOf('123').set(USERS.member, 'VIEWER');

    expect((await checkAccess('123')).status).toBe(202);
    loading.open();

    const member = await connecting;
    expect(accessRequests('123')).toBe(2); // before another client asks for its access
    const owner = await connect('vsum:123', 'owner');
    member.doc.getMap('test').set('fromViewer', 'Hack');
    // The presence is sent after the change on the same connection, so once it arrived the server
    // has handled the change as well.
    member.awareness.setLocalStateField('user', { name: 'Max' });
    await userAppears(owner, 'Max');
    expect(docs.get('vsum:123')?.getMap('test').has('fromViewer')).toBe(false);
  });

  it('accept a connection whose user was removed while its access was being checked, and close it with 4403', async () => {
    const checking = holdAccess('124');
    const messages: unknown[] = [];
    const closed = openRaw('/vsum:124?token=member', messages);
    await checking.requested;
    projects.membersOf('124').delete(USERS.member);

    expect((await checkAccess('124')).status).toBe(202);
    checking.open(); // computed before the removal: still a member

    expect(await closed).toBe(4403);
    expect(messages).toEqual([]);
    expect(accessRequests('124')).toBe(2);
  });

  it('ask for the access once more if another check arrives while it is asked for again', async () => {
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const messages: unknown[] = [];
    const closed = openRaw('/vsum:125?token=member', messages);
    await vi.waitFor(() => expect(projects.loads).toContain('125'));
    const checkingAgain = holdAccess('125');
    expect((await checkAccess('125')).status).toBe(202); // about another user
    loading.open();
    await checkingAgain.requested;
    projects.membersOf('125').delete(USERS.member);

    expect((await checkAccess('125')).status).toBe(202);
    checkingAgain.open(); // computed before the removal: still a member

    expect(await closed).toBe(4403);
    expect(messages).toEqual([]);
    expect(accessRequests('125')).toBe(3);
  });

  /**
   * Opens the project as its owner and starts a member's connection, which a check makes ask for
   * its access again. While that answer, computed before, is held back, the project is removed.
   * Returns the member's connection and lets the held answer through with `open`.
   */
  async function removeWhileAskingAgain(projectId: string) {
    projects.add(projectId, { metaModels: [{ id: 101, sourceId: 1, name: 'Car' }] });
    const owner = await connect(`vsum:${projectId}`, 'owner');
    const ownerClosed = nextCloseCode(owner);
    const checking = holdAccess(projectId);
    const messages: unknown[] = [];
    const closed = openRaw(`/vsum:${projectId}?token=member`, messages);
    await checking.requested;
    const checkingAgain = holdAccess(projectId);
    expect((await checkAccess(projectId)).status).toBe(202); // about another user
    checking.open();
    await checkingAgain.requested;
    projects.missing.add(projectId); // in the trash

    const closeNotification = await notify(`/internal/projects/${projectId}/close`, await backendToken());

    expect(closeNotification.status).toBe(202);
    expect(await ownerClosed).toBe(4410);
    owner.disconnect();
    return { closed, messages, open: checkingAgain.open };
  }

  it('close a connection with 4410 whose project was removed while it asked for the access again', async () => {
    const member = await removeWhileAskingAgain('126');

    member.open();

    expect(await member.closed).toBe(4410); // not joined to a document no room manages
    expect(member.messages).toEqual([]);
    expect(docs.has('vsum:126')).toBe(false);
    projects.missing.delete('126'); // restored
    const owner = await connect('vsum:126', 'owner');
    expect((owner.doc.getMap('models').get('1') as Y.Map<unknown>).get('name')).toBe('Car');
  });

  it('close a connection with 4410 whose project was removed while it asked for the access again, also once it was opened again', async () => {
    const member = await removeWhileAskingAgain('127');
    projects.missing.delete('127'); // restored
    const owner = await connect('vsum:127', 'owner');
    const doc = docs.get('vsum:127');

    member.open();

    expect(await member.closed).toBe(4410); // not joined to the new room
    expect(member.messages).toEqual([]);
    expect(docs.get('vsum:127')).toBe(doc);
    expect(owner.wsconnected).toBe(true);
  });

  it('do not affect connections that start afterwards, which are rejected with 403', async () => {
    projects.membersOf('122').delete(USERS.member);

    expect((await checkAccess('122')).status).toBe(202);

    await expect(rejectionStatus('/vsum:122?token=member')).resolves.toBe(403);
  });
});

describe('check-access notifications (user)', () => {
  const checkUserAccess = async (userId: string) =>
    notify(`/internal/users/${userId}/check-access`, await backendToken());

  /** Removes the user from the projects, like deleting the account does in the backend. */
  const deleteAccount = (userId: string, ...projectIds: string[]) => {
    for (const projectId of projectIds) {
      projects.membersOf(projectId).delete(userId);
    }
  };

  it("close the user's connections in every room and leave the other users alone", async () => {
    const owners = [await connect('vsum:130', 'owner'), await connect('vsum:131', 'owner')];
    const tabs = [await connect('vsum:130', 'member2'), await connect('vsum:131', 'member2')];
    const unrelated = await connect('vsum:132', 'owner');
    const closes = tabs.map((tab) => nextCloseCode(tab));
    deleteAccount(USERS.member2, '130', '131', '132');
    const memberLoads = projects.memberLoads.length;

    const response = await checkUserAccess(USERS.member2);

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('Checked');
    expect(await Promise.all(closes)).toEqual([4403, 4403]);
    for (const tab of tabs) {
      tab.disconnect();
    }
    // Only the rooms the user is connected to.
    expect(projects.memberLoads.slice(memberLoads).sort()).toEqual(['130', '131']);
    expect([...owners, unrelated].map((provider) => provider.wsconnected)).toEqual([true, true, true]);
  });

  it('do nothing, without asking the backend, for a user without connections', async () => {
    const memberLoads = projects.memberLoads.length;

    const response = await checkUserAccess('999');

    expect(response.status).toBe(202);
    expect(projects.memberLoads).toHaveLength(memberLoads);
  });

  it('are answered with 503 if the members of one room cannot be loaded, after checking the other rooms', async () => {
    const tabs = [await connect('vsum:133', 'member2'), await connect('vsum:134', 'member2')];
    const codes = new Map<WebsocketProvider, number | undefined>();
    for (const tab of tabs) {
      void nextCloseCode(tab).then((code) => codes.set(tab, code));
    }
    deleteAccount(USERS.member2, '133', '134');
    projects.nextMemberLoads.push(new BackendError(503, 'The backend answered GET with status 503'));

    expect((await checkUserAccess(USERS.member2)).status).toBe(503);

    await vi.waitFor(() => expect([...codes.values()]).toEqual([4403]));
    const [closedTab] = codes.keys();
    closedTab.disconnect();
    const keptTab = tabs.find((tab) => tab !== closedTab) as WebsocketProvider;
    expect(keptTab.wsconnected).toBe(true);
    expect((await checkUserAccess(USERS.member2)).status).toBe(202);
    await vi.waitFor(() => expect(codes.get(keptTab)).toBe(4403));
    keptTab.disconnect();
  });

  it('make connections that are still loading ask for the access again', async () => {
    projects.add('135');
    const loading = gate();
    projects.nextLoads.push(loading.interruption);
    const closed = openRaw('/vsum:135?token=member2');
    await vi.waitFor(() => expect(projects.loads).toContain('135'));
    deleteAccount(USERS.member2, '135');

    expect((await checkUserAccess(USERS.member2)).status).toBe(202);
    loading.open();

    expect(await closed).toBe(4403);
    expect(accessRequests('135')).toBe(2);
  });
});

describe.each([
  ['project', (id: string) => `/internal/projects/${id}/check-access`, 'check-access'],
  ['user', (id: string) => `/internal/users/${id}/check-access`, 'check-user-access'],
])('check-access notifications (%s)', (_kind, path, notification) => {
  it.each([
    ['without token', undefined],
    ['with an invalid token', 'Bearer not-a-token'],
  ])('are rejected with 401 %s', async (_name, authorization) => {
    const response = await notify(path('70'), authorization);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('are rejected with 401 if the token is forged or expired', async () => {
    for (const options of [{ forged: true }, { expiresIn: -60 }]) {
      const token = await keycloak.signToken({ roles: [BACKEND_ROLE], ...options });

      expect((await notify(path('70'), `Bearer ${token}`)).status).toBe(401);
    }
  });

  it("are rejected with 403 if the token lacks the backend's role", async () => {
    const userToken = await keycloak.signToken({ roles: ['user'] });

    expect((await notify(path('70'), `Bearer ${userToken}`)).status).toBe(403);
  });

  it.each(['abc', '012', '-1', '1234567890123456789'])(
    'are rejected with 400 for the invalid ID %s',
    async (id) => {
      expect((await notify(path(id), await backendToken())).status).toBe(400);
    },
  );

  it('check the token before the ID', async () => {
    expect((await notify(path('abc'))).status).toBe(401);
  });

  it('only accept POST', async () => {
    const response = await notify(path('70'), await backendToken(), 'GET');

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('never log the token', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE], forged: true });
    await notify(path('70'), `Bearer ${token}`);

    const logged = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls]
      .flat()
      .join(' ');
    expect(logged).toContain(`Rejected a ${notification} notification`);
    expect(logged).not.toContain(token);
  });
});
