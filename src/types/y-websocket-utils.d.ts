// y-websocket ships no type declarations for its server part, so the parts we use are declared here.
declare module 'y-websocket/bin/utils' {
  import type { IncomingMessage } from 'node:http';
  import type { WebSocket } from 'ws';
  import type { Doc } from 'yjs';

  /** The document of a room, shared by all its connections. */
  export class WSSharedDoc extends Doc {
    readonly name: string;
  }

  /** The documents of all rooms, by room name. */
  export const docs: Map<string, WSSharedDoc>;

  /**
   * Returns the document of the room `docName` from {@link docs}, or creates and adds it if there is
   * none.
   */
  export function getYDoc(docName: string, gc?: boolean): WSSharedDoc;

  /**
   * Sets how documents are stored. With `null`, documents are kept in memory and never removed
   * from {@link docs}. The environment variable `YPERSISTENCE` sets a LevelDB storage instead.
   */
  export function setPersistence(persistence: null): void;

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
