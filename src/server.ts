import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { setPersistence, setupWSConnection } from 'y-websocket/bin/utils';
import { AccessError, fetchRole, parseRoomName, type BackendOptions, type Role } from './access.js';
import { BackendError, type BackendClient } from './backend.js';
import { describeError } from './errors.js';
import { makeReadOnly } from './readOnly.js';
import { EPOCH_PARAM, OUTDATED_DOCUMENT_CLOSE_CODE } from './document.js';
import { createRooms, OutdatedDocumentError, RoomsClosedError, type JoinedRoom } from './rooms.js';
import type { WritebackTimings } from './writeback.js';

/**
 * How long shutting down waits for the last writebacks. Docker kills a container 10 seconds after
 * asking it to stop.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

/** Largest message a client may send. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CollaborationServerOptions extends BackendOptions {
  /** Client of the backend's internal endpoints, which loads projects and writes changes back. */
  backend: BackendClient;
  /** Defaults to {@link DEFAULT_WRITEBACK_TIMINGS}. */
  writeback?: Partial<WritebackTimings>;
  /** Defaults to {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
  shutdownTimeoutMs?: number;
}

export interface CollaborationServer {
  /** Starts listening. Resolves with the port, which is useful with port `0` in tests. */
  listen(port: number): Promise<number>;
  /**
   * Stops accepting connections, disconnects all clients, writes their changes back and stops.
   * Later calls return the same promise.
   */
  close(): Promise<void>;
}

/** The room a connection may join, the role of its user there and the epoch of its document. */
interface Access {
  roomName: string;
  projectId: string;
  role: Role;
  /** The epoch the client sent; `undefined` for an empty document. */
  epoch: string | undefined;
}

/**
 * Creates the collaboration server without starting it.
 *
 * - `GET /health` answers `200` so Docker and monitoring can check that the server runs.
 * - WebSocket connections join the room named by the URL path and pass the user's access token as
 *   a query parameter, e.g. `ws://host:1234/vsum:12?token=...` joins `vsum:12`. Everyone in a room
 *   shares one Yjs document.
 * - Before a connection is accepted, the backend is asked for the user's role in the project.
 *   Users without access are rejected, and viewers can read but not change the document.
 * - The first connection to a room loads the project into the document; the connection is accepted
 *   once that is done. The users' changes are written back to the backend (see `rooms.ts`).
 * - A client with a document sends its epoch (`?token=...&epoch=...`). If that isn't the current
 *   room's epoch, or the project has no room, its document is outdated: the connection is accepted
 *   and closed with code `4409` without joining or loading the room, so nothing of the document
 *   reaches it. Browsers can read close codes, but not the status of a rejected handshake.
 *
 * Only one server per process: rooms are kept in y-websocket's module-wide `docs` map.
 */
export function createCollaborationServer(options: CollaborationServerOptions): CollaborationServer {
  // Documents are loaded and written back by the rooms; y-websocket must neither store them (as it
  // would with YPERSISTENCE set) nor drop them when the last user leaves.
  setPersistence(null);
  const rooms = createRooms({ backend: options.backend, writeback: options.writeback });
  // A project's document is small; ws would accept messages of up to 100 MiB.
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** Connections that wait for the backend's answer and are not WebSocket connections yet. */
  const waiting = new Set<Duplex>();
  let closing = false;

  const httpServer = createServer(handleHttpRequest);
  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Without a listener, a connection error while waiting for the backend would crash the server.
    socket.on('error', () => socket.destroy());
    if (closing) {
      reject(socket, new AccessError(503, 'The server is shutting down'));
      return;
    }
    waiting.add(socket);
    connect(request, socket, head).then(
      () => waiting.delete(socket),
      (error: unknown) => {
        waiting.delete(socket);
        reject(socket, error);
      },
    );
  });

  async function connect(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { roomName, projectId, role, epoch } = await checkAccess(request, options);
    let room: JoinedRoom;
    try {
      room = await joinRoom(roomName, projectId, epoch);
    } catch (error) {
      if (!(error instanceof OutdatedDocumentError)) {
        throw error;
      }
      closeOutdated(request, socket, head, roomName);
      return;
    }
    // The raw socket closes in every case: when the WebSocket closes, and also when the upgrade
    // below is aborted without ever creating one (e.g. the client went away while loading).
    socket.once('close', room.release);
    if (socket.destroyed) {
      room.release();
      return;
    }
    if (closing) {
      room.release();
      throw new AccessError(503, 'The server is shutting down');
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      // ws reports invalid frames as errors and then closes the connection. Without a listener, the
      // error would crash the server. Only the message is logged: the request URL has the token.
      webSocket.on('error', (error) => {
        console.error(`A connection to ${roomName} failed:`, error.message);
      });
      // The role is checked once per connection, so it stays the same until the client reconnects.
      if (role === 'VIEWER') {
        makeReadOnly(webSocket);
      }
      setupWSConnection(webSocket, request, { docName: roomName });
    });
  }

  /** Accepts the connection of a client whose document is outdated and closes it with `4409`. */
  function closeOutdated(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    roomName: string,
  ): void {
    // ws destroys a socket that went away meanwhile instead of upgrading it.
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      // Messages are never read: nothing of the outdated document reaches a room. Without an error
      // listener, an invalid frame sent before the close would crash the server.
      webSocket.on('error', (error) => {
        console.error(`A connection to ${roomName} failed:`, error.message);
      });
      webSocket.close(OUTDATED_DOCUMENT_CLOSE_CODE, 'Outdated document');
    });
  }

  async function joinRoom(
    roomName: string,
    projectId: string,
    epoch: string | undefined,
  ): Promise<JoinedRoom> {
    try {
      return await rooms.join(roomName, projectId, epoch);
    } catch (error) {
      if (error instanceof OutdatedDocumentError) {
        throw error;
      }
      if (error instanceof RoomsClosedError) {
        throw new AccessError(503, error.message);
      }
      if (error instanceof BackendError && error.status === 404) {
        throw new AccessError(403, 'The project does not exist');
      }
      throw new AccessError(503, `The project could not be loaded: ${describeError(error)}`);
    }
  }

  let stopping: Promise<void> | undefined;

  /** Stops the server; see {@link CollaborationServer.close}. */
  async function stop(): Promise<void> {
    closing = true;
    // Stop accepting connections first, so that disconnected clients can't come back meanwhile.
    const stopped = new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    // Awaited below; without a handler meanwhile, an early failure would be an unhandled rejection.
    stopped.catch(() => {});
    for (const socket of waiting) {
      socket.destroy();
    }
    for (const client of webSockets.clients) {
      client.terminate();
    }
    try {
      await rooms.closeAll(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    } finally {
      webSockets.close();
      // Upgraded connections would keep the HTTP server open.
      httpServer.closeAllConnections();
      await stopped;
    }
  }

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          httpServer.off('error', reject);
          resolve((httpServer.address() as AddressInfo).port);
        });
      }),
    close: () => {
      // A second call (e.g. SIGINT after SIGTERM) waits for the first instead of closing again.
      stopping ??= stop();
      return stopping;
    },
  };
}

/**
 * Reads room name and token from the request URL and asks the backend for the user's role.
 *
 * @throws AccessError if the connection must be rejected
 */
async function checkAccess(request: IncomingMessage, options: BackendOptions): Promise<Access> {
  let roomName: string;
  let token: string | null;
  let epoch: string | undefined;
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    roomName = decodeURIComponent(url.pathname.slice(1));
    token = url.searchParams.get('token');
    // An empty document has no epoch yet; an empty parameter counts as none.
    epoch = url.searchParams.get(EPOCH_PARAM) || undefined;
  } catch {
    throw new AccessError(400, 'The request URL is invalid');
  }
  const projectId = parseRoomName(roomName);
  return { roomName, projectId, epoch, role: await fetchRole(projectId, token, options) };
}

/** Answers the upgrade request with an HTTP error instead of opening a WebSocket connection. */
function reject(socket: Duplex, error: unknown): void {
  const status = error instanceof AccessError ? error.status : 500;
  if (status >= 500) {
    // Only the message is logged, never the request URL: it contains the access token.
    console.error('Rejected a connection:', error instanceof Error ? error.message : error);
  }
  if (socket.destroyed) {
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'UP' }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('Not found');
}
