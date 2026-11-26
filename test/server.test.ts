import { connect as connectTcp } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { docs, setPersistence } from 'y-websocket/bin/utils';
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
 * The fake backend knows these tokens. `owner`, `member` and `viewer` have that role in every
 * project except project 404, which doesn't exist. The other tokens trigger the named problem.
 */
function answer(token: string | undefined, projectId: string): FakeAnswer {
  switch (token) {
    case 'owner':
    case 'member':
    case 'viewer':
      return projectId === '404' ? { status: 404 } : details(token.toUpperCase());
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
      return details('ADMIN');
    default:
      return { status: 401 };
  }
}

/** Short delays, so that tests don't wait 5 seconds for a writeback. */
const TIMINGS = { debounceMs: 20, maxWaitMs: 200, minRetryDelayMs: 10, maxRetryDelayMs: 40 };

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
  backend = await startFakeBackend(answer);
  keycloak = await startFakeKeycloak();
  backendTokens = createBackendTokenVerifier({ url: keycloak.url, realm: REALM, timeoutMs: 300 });
  projects = new FakeProjects();
  server = createCollaborationServer({
    backendUrl: backend.url,
    backendTimeoutMs: 300,
    backend: projects,
    backendTokens,
    writeback: TIMINGS,
  });
  const port = await server.listen(0);
  httpUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}`;
  // Rejections caused by the backend are logged, which is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const provider of providers.splice(0)) {
    provider.destroy();
  }
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
    for (const path of ['/internal/projects/70', '/internal/projects/70/reload/x', '/internal']) {
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
