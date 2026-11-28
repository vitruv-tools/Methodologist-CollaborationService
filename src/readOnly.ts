import type { RawData, WebSocket } from 'ws';

// Message types of the y-websocket protocol: the first number of a message is its type, and for
// sync messages the second number is the step.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;

/**
 * Whether a connection that may only read is allowed to send this message.
 *
 * Allowed are sync step 1 (asking for the current state) and awareness (presence: cursor,
 * selection). Sync step 2 and updates carry document changes and are not allowed, and neither is
 * anything unknown.
 */
export function isAllowedForViewer(message: Uint8Array): boolean {
  // All type and step numbers are below 128, so each is encoded as a single byte.
  switch (message[0]) {
    case MESSAGE_SYNC:
      return message[1] === SYNC_STEP_1;
    case MESSAGE_AWARENESS:
      return true;
    default:
      return false;
  }
}

/**
 * What a connection may send: everything, only what {@link isAllowedForViewer} allows, or nothing.
 */
export type Permission = 'write' | 'read' | 'none';

/** The filter of a connection's messages; see {@link guardMessages}. */
export interface MessageGuard {
  /** What the connection may send now. */
  readonly permission: Permission;
  /**
   * Narrows what the connection may send, from the next message on: from `write` to `read` or
   * `none`, and from `read` to `none`. Never widens it.
   */
  restrict(permission: Permission): void;
}

const WIDTH: Record<Permission, number> = { none: 0, read: 1, write: 2 };

/**
 * Filters the messages of a connection before any listener sees them, by its current permission:
 * `write` lets every message pass, `read` drops the messages that would change the document, and
 * `none` drops all. Call it before `setupWSConnection`, which has no read-only option itself.
 *
 * Before the server closes a connection itself, it restricts the connection to `none`: ws still
 * emits the messages that arrive while the connection is closing. Other events (`close`, `error`,
 * `pong`) always pass, so the connection is still cleaned up.
 */
export function guardMessages(socket: WebSocket, initial: 'write' | 'read'): MessageGuard {
  let permission: Permission = initial;
  const emit = socket.emit.bind(socket);
  socket.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'message' && !allows(permission, args[0] as RawData)) {
      return false;
    }
    return emit(event, ...args);
  };
  return {
    get permission() {
      return permission;
    },
    restrict(next) {
      if (WIDTH[next] < WIDTH[permission]) {
        permission = next;
      }
    },
  };
}

function allows(permission: Permission, data: RawData): boolean {
  switch (permission) {
    case 'write':
      return true;
    case 'read':
      return isAllowedForViewer(toBytes(data));
    default:
      return false;
  }
}

function toBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return Array.isArray(data) ? Buffer.concat(data) : data;
}
