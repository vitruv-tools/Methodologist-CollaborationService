import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from 'y-websocket/bin/utils';

export interface CollaborationServer {
  /** Starts listening. Resolves with the port, which is useful with port `0` in tests. */
  listen(port: number): Promise<number>;
  /** Disconnects all clients and stops the server. */
  close(): Promise<void>;
}

/**
 * Creates the collaboration server without starting it.
 *
 * - `GET /health` answers `200` so Docker and monitoring can check that the server runs.
 * - WebSocket connections join the room named by the URL path, e.g. `ws://host:1234/vsum:12` joins
 *   `vsum:12`. Everyone in a room shares one Yjs document, which is kept in memory.
 */
export function createCollaborationServer(): CollaborationServer {
  const webSockets = new WebSocketServer({ noServer: true });
  webSockets.on('connection', (socket, request: IncomingMessage) => {
    setupWSConnection(socket, request);
  });

  const httpServer = createServer(handleHttpRequest);
  httpServer.on('upgrade', (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
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
        // Upgraded WebSocket connections would keep the HTTP server open, so end them first.
        for (const client of webSockets.clients) {
          client.terminate();
        }
        webSockets.close();
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      }),
  };
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
