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
 * Makes a connection read-only: messages that would change the document are dropped before any
 * listener sees them. Call it before `setupWSConnection`, which has no read-only option itself.
 */
export function makeReadOnly(socket: WebSocket): void {
  const emit = socket.emit.bind(socket);
  socket.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'message' && !isAllowedForViewer(toBytes(args[0] as RawData))) {
      return false;
    }
    return emit(event, ...args);
  };
}

function toBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return Array.isArray(data) ? Buffer.concat(data) : data;
}
