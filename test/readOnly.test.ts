import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { guardMessages, isAllowedForViewer, type Permission } from '../src/readOnly.js';

describe('isAllowedForViewer', () => {
  it.each([
    ['sync step 1', [0, 0, 1, 0], true],
    ['sync step 2', [0, 1, 2, 0, 0], false],
    ['an update', [0, 2, 2, 0, 0], false],
    ['an unknown sync step', [0, 3], false],
    ['a sync message without a step', [0], false],
    ['awareness', [1, 1, 0], true],
    ['an auth message', [2, 0], false],
    ['an awareness query', [3], false],
    ['an empty message', [], false],
  ])('%s: %j -> %s', (_name, bytes, allowed) => {
    expect(isAllowedForViewer(Uint8Array.from(bytes))).toBe(allowed);
  });
});

describe('guardMessages', () => {
  const SYNC_STEP_1 = [0, 0, 1, 0];
  const UPDATE = [0, 2, 2, 0, 0];
  const AWARENESS = [1, 1, 0];

  /** A stand-in for a connection that records the messages its listeners get. */
  function connection(): { socket: WebSocket; received: number[][] } {
    const socket = new EventEmitter() as unknown as WebSocket;
    const received: number[][] = [];
    socket.on('message', (data: ArrayBuffer | Buffer) => {
      received.push([...(data instanceof ArrayBuffer ? new Uint8Array(data) : data)]);
    });
    return { socket, received };
  }

  /** Emits the messages like ws, as `ArrayBuffer`s (the type y-websocket asks for). */
  function send(socket: WebSocket, ...messages: number[][]): void {
    for (const message of messages) {
      socket.emit('message', Uint8Array.from(message).buffer, true);
    }
  }

  it('lets every message pass with write', () => {
    const { socket, received } = connection();
    guardMessages(socket, 'write');

    send(socket, SYNC_STEP_1, UPDATE, AWARENESS);

    expect(received).toEqual([SYNC_STEP_1, UPDATE, AWARENESS]);
  });

  it('lets only sync step 1 and awareness pass with read', () => {
    const { socket, received } = connection();
    guardMessages(socket, 'read');

    send(socket, SYNC_STEP_1, UPDATE, AWARENESS);
    socket.emit('message', Buffer.from(UPDATE), true); // as ws emits it by default

    expect(received).toEqual([SYNC_STEP_1, AWARENESS]);
  });

  it('drops every message once restricted to none, from the next message on', () => {
    const { socket, received } = connection();
    const guard = guardMessages(socket, 'write');
    send(socket, UPDATE);

    guard.restrict('none');
    send(socket, SYNC_STEP_1, UPDATE, AWARENESS);

    expect(guard.permission).toBe('none');
    expect(received).toEqual([UPDATE]);
  });

  it.each<['write' | 'read', Permission, Permission]>([
    ['write', 'read', 'read'],
    ['write', 'none', 'none'],
    ['read', 'none', 'none'],
    ['read', 'write', 'read'],
    ['read', 'read', 'read'],
  ])('narrows %s when restricted to %s, to %s, and never widens it', (initial, restricted, result) => {
    const { socket } = connection();
    const guard = guardMessages(socket, initial);

    guard.restrict(restricted);

    expect(guard.permission).toBe(result);
  });

  it('never widens none again', () => {
    const { socket, received } = connection();
    const guard = guardMessages(socket, 'write');
    guard.restrict('none');

    guard.restrict('write');
    guard.restrict('read');
    send(socket, SYNC_STEP_1, UPDATE);

    expect(guard.permission).toBe('none');
    expect(received).toEqual([]);
  });

  it('still emits close, error and pong with none, so the connection is cleaned up', () => {
    const { socket } = connection();
    const events: string[] = [];
    for (const event of ['close', 'error', 'pong']) {
      socket.on(event, () => events.push(event));
    }
    guardMessages(socket, 'read').restrict('none');

    socket.emit('close', 4403, Buffer.from('Access revoked'));
    socket.emit('error', new Error('Invalid frame'));
    socket.emit('pong', Buffer.alloc(0));

    expect(events).toEqual(['close', 'error', 'pong']);
  });
});
