// y-websocket ships no type declarations for its server part, so the parts we use are declared here.
declare module 'y-websocket/bin/utils' {
  import type { IncomingMessage } from 'node:http';
  import type { WebSocket } from 'ws';

  /**
   * Adds a WebSocket connection to the room (shared document) named `docName`, which defaults to the
   * request path without the leading slash, and syncs it with the other connections of that room.
   */
  export function setupWSConnection(
    conn: WebSocket,
    req: IncomingMessage,
    options?: { docName?: string; gc?: boolean },
  ): void;
}
