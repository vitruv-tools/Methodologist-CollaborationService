import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { createCollaborationServer, type CollaborationServer } from '../src/server.js';
import { details, startFakeBackend, type FakeAnswer, type FakeBackend } from './fakeBackend.js';

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

let backend: FakeBackend;
let server: CollaborationServer;
let httpUrl: string;
let wsUrl: string;
const providers: WebsocketProvider[] = [];

beforeAll(async () => {
  backend = await startFakeBackend(answer);
  server = createCollaborationServer({ backendUrl: backend.url, backendTimeoutMs: 300 });
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
  vi.restoreAllMocks();
});

/**
 * Connects a new client to the given room and waits until it is synced. The client starts with
 * `doc` if given, otherwise with an empty document.
 */
async function connect(room: string, token: string, doc = new Y.Doc()): Promise<WebsocketProvider> {
  const provider = new WebsocketProvider(wsUrl, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Clients in one process would otherwise sync through a BroadcastChannel, bypassing the server.
    disableBc: true,
    params: { token },
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

  it.each(['/', '/vsum', '/vsum:', '/vsum:abc', '/vsum:1a', '/vsum:-1', '/vsum:1/x', '/room:1', '/%'])(
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
    const lonelyServer = createCollaborationServer({ backendUrl: stopped.url });
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
