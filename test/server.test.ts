import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { createCollaborationServer, type CollaborationServer } from '../src/server.js';

let server: CollaborationServer;
let httpUrl: string;
let wsUrl: string;
const providers: WebsocketProvider[] = [];

beforeAll(async () => {
  server = createCollaborationServer();
  const port = await server.listen(0);
  httpUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}`;
});

afterEach(() => {
  for (const provider of providers.splice(0)) {
    provider.destroy();
  }
});

afterAll(async () => {
  await server.close();
});

/** Connects a new client with its own document to the given room and waits until it is synced. */
async function connect(room: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(wsUrl, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Clients in one process would otherwise sync through a BroadcastChannel, bypassing the server.
    disableBc: true,
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
  return doc;
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
  it('shares changes between clients in the same room', async () => {
    const alice = await connect('vsum:1');
    const bob = await connect('vsum:1');

    alice.getMap('test').set('name', 'Component');

    await expect(valueArrives(bob, 'name')).resolves.toBe('Component');
  });

  it('gives a client that joins later the current state', async () => {
    const alice = await connect('vsum:2');
    const bob = await connect('vsum:2');
    alice.getMap('test').set('name', 'Component');
    await valueArrives(bob, 'name'); // the server has the change by now

    const carol = await connect('vsum:2');

    expect(carol.getMap('test').get('name')).toBe('Component');
  });

  it('keeps rooms separate', async () => {
    const alice = await connect('vsum:3');
    const bob = await connect('vsum:3');
    const other = await connect('vsum:4');

    alice.getMap('test').set('name', 'Component');
    await valueArrives(bob, 'name'); // the server has forwarded the change by now

    expect(other.getMap('test').has('name')).toBe(false);
  });
});
