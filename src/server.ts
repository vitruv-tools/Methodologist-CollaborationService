import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from 'y-websocket/bin/utils';
import { AccessError, fetchRole, parseRoomName, type BackendOptions, type Role } from './access.js';
import { makeReadOnly } from './readOnly.js';

export interface CollaborationServer {
  /** Starts listening. Resolves with the port, which is useful with port `0` in tests. */
  listen(port: number): Promise<number>;
  /** Disconnects all clients and stops the server. */
  close(): Promise<void>;
}

/** The room a connection may join and the role of its user there. */
interface Access {
  roomName: string;
  role: Role;
}

/**
 * Creates the collaboration server without starting it.
 *
 * - `GET /health` answers `200` so Docker and monitoring can check that the server runs.
 * - WebSocket connections join the room named by the URL path and pass the user's access token as
 *   a query parameter, e.g. `ws://host:1234/vsum:12?token=...` joins `vsum:12`. Everyone in a room
 *   shares one Yjs document, which is kept in memory.
 * - Before a connection is accepted, the backend is asked for the user's role in the project.
 *   Users without access are rejected, and viewers can read but not change the document.
 */
export function createCollaborationServer(options: BackendOptions): CollaborationServer {
  const webSockets = new WebSocketServer({ noServer: true });
  /** Connections that wait for the backend's answer and are not WebSocket connections yet. */
  const waiting = new Set<Duplex>();

  const httpServer = createServer(handleHttpRequest);
  httpServer.on('upgrade', (request, socket, head) => {
    // Without a listener, a connection error while waiting for the backend would crash the server.
    socket.on('error', () => socket.destroy());
    waiting.add(socket);
    checkAccess(request, options).then(
      ({ roomName, role }) => {
        waiting.delete(socket);
        if (socket.destroyed) {
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
          // The role is checked once per connection, so it stays the same until the client reconnects.
          if (role === 'VIEWER') {
            makeReadOnly(webSocket);
          }
          setupWSConnection(webSocket, request, { docName: roomName });
        });
      },
      (error: unknown) => {
        waiting.delete(socket);
        reject(socket, error);
      },
    );
  });

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          httpServer.off('error', reject);
          resolve((httpServer.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        // Upgraded connections would keep the HTTP server open, so end them first.
        for (const socket of waiting) {
          socket.destroy();
        }
        for (const client of webSockets.clients) {
          client.terminate();
        }
        webSockets.close();
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      }),
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
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    roomName = decodeURIComponent(url.pathname.slice(1));
    token = url.searchParams.get('token');
  } catch {
    throw new AccessError(400, 'The request URL is invalid');
  }
  const projectId = parseRoomName(roomName);
  return { roomName, role: await fetchRole(projectId, token, options) };
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
