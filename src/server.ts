import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { setPersistence, setupWSConnection } from 'y-websocket/bin/utils';
import {
  AccessError,
  fetchAccess,
  parseRoomName,
  parseUserId,
  type BackendOptions,
  type Role,
} from './access.js';
import { BackendError, type BackendClient } from './backend.js';
import { TokenError, type BackendTokenVerifier } from './backendToken.js';
import { describeError } from './errors.js';
import { guardMessages, type MessageGuard } from './readOnly.js';
import {
  ACCESS_REVOKED_CLOSE_CODE,
  EPOCH_PARAM,
  OUTDATED_DOCUMENT_CLOSE_CODE,
  PROJECT_REMOVED_CLOSE_CODE,
  ROLE_CHANGED_CLOSE_CODE,
} from './document.js';
import {
  createRooms,
  OutdatedDocumentError,
  ProjectRemovedError,
  RoomsClosedError,
  type JoinedRoom,
} from './rooms.js';
import type { WritebackTimings } from './writeback.js';

/**
 * How long shutting down waits for the last writebacks. Docker kills a container 10 seconds after
 * asking it to stop.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

/** Largest message a client may send. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * How long a client may take to complete the close of a connection the server closed itself
 * (`4403`, `4410`, `4412`) before the connection is terminated. Without it, ws would wait 30
 * seconds, and the client's presence would stay in the room meanwhile.
 */
export const DEFAULT_REVOKED_CLOSE_TIMEOUT_MS = 5000;

export interface CollaborationServerOptions extends BackendOptions {
  /**
   * Client of the backend's internal endpoints, which loads projects, writes changes back and
   * lists the members of a project.
   */
  backend: BackendClient;
  /** Checks the token the backend sends its notifications with. */
  backendTokens: BackendTokenVerifier;
  /** Defaults to {@link DEFAULT_WRITEBACK_TIMINGS}. */
  writeback?: Partial<WritebackTimings>;
  /** Defaults to {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
  shutdownTimeoutMs?: number;
  /** Defaults to {@link DEFAULT_REVOKED_CLOSE_TIMEOUT_MS}. */
  revokedCloseTimeoutMs?: number;
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

/** What a connection asks for: the room to join, the user's token and the epoch of its document. */
interface ConnectionRequest {
  roomName: string;
  projectId: string;
  /** The user's access token; `null` if the client sent none. */
  token: string | null;
  /** The epoch the client sent; `undefined` for an empty document. */
  epoch: string | undefined;
}

/** A joined connection: its room, its user and what it may send. */
interface Connection {
  roomName: string;
  /** The backend's ID of the user, from `GET /api/v1/vsums/{id}/details`. */
  userId: string;
  /** The role the user had when the connection was accepted. */
  role: Role;
  /** Filters the connection's messages; `none` once the server closes the connection. */
  guard: MessageGuard;
}

/** A connection that is being checked or waits for its room to load; see `markStale`. */
interface PendingJoin {
  /** Whether the user's access must be fetched again before the connection is accepted. */
  stale: boolean;
}

/**
 * Creates the collaboration server without starting it.
 *
 * - `GET /health` answers `200` so Docker and monitoring can check that the server runs.
 * - WebSocket connections join the room named by the URL path and pass the user's access token as
 *   a query parameter, e.g. `ws://host:1234/vsum:12?token=...` joins `vsum:12`. Everyone in a room
 *   shares one Yjs document.
 * - Before a connection is accepted, the backend is asked for the user's role in the project and
 *   the user's ID (`GET /api/v1/vsums/{id}/details`). Users without access are rejected, and
 *   viewers can read but not change the document. An answer without the user's ID is rejected
 *   with `503`: without it, the connection could not be closed when the user loses access.
 * - The first connection to a room loads the project into the document; the connection is accepted
 *   once that is done. The users' changes are written back to the backend (see `rooms.ts`).
 * - A client with a document sends its epoch (`?token=...&epoch=...`). If that isn't the current
 *   room's epoch, or the project has no room, its document is outdated: the connection is accepted
 *   and closed with code `4409` without joining or loading the room, so nothing of the document
 *   reaches it. Browsers can read close codes, but not the status of a rejected handshake.
 * - `POST /internal/projects/{id}/reload`, called by the backend with its service account's token,
 *   reloads the project's room after the backend changed the project outside the document. It
 *   answers `202` once the reload started, also if the project has no room.
 * - `POST /internal/projects/{id}/close`, called the same way after the project was moved to the
 *   trash or deleted, drops the project's room without writing it back and closes its connections
 *   with code `4410`, once the backend confirmed that it no longer has the project. It answers
 *   `202`, also if the project has no room or the backend still has it (a late notification), and
 *   `503` if the backend could not be asked, so the backend sends the notification again.
 * - `POST /internal/projects/{id}/check-access`, called the same way after the backend took access
 *   to the project away from a user, and `POST /internal/users/{id}/check-access`, called after a
 *   user's account was deleted, compare the connections of the project's room, or of every room
 *   the user is connected to, with the project's current members
 *   (`GET /api/internal/v1/vsums/{id}/members`). The connections of users who are no longer members
 *   are closed with code `4403`, those of owners and members who may now only view the project
 *   with `4412`. Other connections stay, also if their user may now do more: the role is applied
 *   when the user connects again. Connections still being checked or loading their room ask the
 *   backend for the user's access again before they are accepted; one that has none anymore is
 *   accepted and closed with `4403` without joining, and one whose project was removed meanwhile
 *   with `4410`. The server decides from the backend's current state only, so a late or repeated
 *   notification is harmless. It answers `202`, and `503` if the members could not be loaded, so
 *   the backend sends the notification again.
 * - Before the server closes a connection itself (`4403`, `4410`, `4412`), it drops every further
 *   message of it, also those that arrive while the connection is closing. If the client doesn't
 *   complete the close within `revokedCloseTimeoutMs`, the connection is terminated.
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
  const revokedCloseTimeoutMs = options.revokedCloseTimeoutMs ?? DEFAULT_REVOKED_CLOSE_TIMEOUT_MS;
  /** Connections that wait for the backend's answer and are not WebSocket connections yet. */
  const waiting = new Set<Duplex>();
  /** Each joined connection; connections closed without joining (e.g. as outdated) have none. */
  const connections = new WeakMap<WebSocket, Connection>();
  /**
   * Connections that are being checked or wait for their room to load, by room name. A check of
   * the room's access marks them stale: the access they fetched may be older than the change that
   * caused the check.
   */
  const pendingJoins = new Map<string, Set<PendingJoin>>();
  let closing = false;

  const httpServer = createServer((request, response) => {
    handleHttpRequest(request, response, {
      reload: notifyReload,
      close: notifyClose,
      'check-access': notifyCheckAccess,
      'check-user-access': notifyCheckUserAccess,
    });
  });

  /**
   * Handles the backend's notification that a project changed outside the document.
   *
   * @throws TokenError if the token isn't the backend's, AccessError (`400`) if the ID is invalid
   */
  async function notifyReload(projectId: string, authorization: string | undefined): Promise<void> {
    void rooms.reload(await checkNotification(projectId, authorization));
  }

  /**
   * Handles the backend's notification that a project was moved to the trash or deleted.
   *
   * @throws TokenError if the token isn't the backend's, AccessError (`400`) if the ID is invalid
   */
  async function notifyClose(projectId: string, authorization: string | undefined): Promise<void> {
    await closeRemovedProject(await checkNotification(projectId, authorization));
  }

  /**
   * Handles the backend's notification that it took access to a project away from a user, e.g.
   * by removing a member.
   *
   * @throws TokenError if the token isn't the backend's, AccessError (`400`) if the ID is invalid
   *     and (`503`) if the members could not be loaded
   */
  async function notifyCheckAccess(
    projectId: string,
    authorization: string | undefined,
  ): Promise<void> {
    const roomName = await checkNotification(projectId, authorization);
    markStale(pendingJoins.get(roomName));
    if (closing) {
      return;
    }
    await checkRoom(roomName, projectId);
  }

  /**
   * Handles the backend's notification that a user's account was deleted. Checks every room the
   * user has a connection to; the user's joins in progress are not known by user, so all of them
   * fetch their access again.
   *
   * @throws TokenError if the token isn't the backend's, AccessError (`400`) if the ID is invalid
   *     and (`503`) if the members of a room could not be loaded
   */
  async function notifyCheckUserAccess(
    userId: string,
    authorization: string | undefined,
  ): Promise<void> {
    await options.backendTokens.verify(authorization);
    parseUserId(userId);
    for (const joins of pendingJoins.values()) {
      markStale(joins);
    }
    if (closing) {
      return;
    }
    const roomNames = new Set<string>();
    for (const client of webSockets.clients) {
      const connection = connections.get(client);
      if (connection?.userId === userId && isActive(client, connection)) {
        roomNames.add(connection.roomName);
      }
    }
    // Every room is checked, also if another fails; checking a room again is harmless.
    const results = await Promise.allSettled(
      [...roomNames].map((roomName) => checkRoom(roomName, parseRoomName(roomName))),
    );
    const failures: unknown[] = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AccessError(
        503,
        `The access could not be checked in ${failures.length} of ${roomNames.size} rooms: ` +
          describeError(failures[0]),
      );
    }
  }

  /**
   * Compares the connections of a room with the project's current members and closes those of
   * users who are no longer members (`4403`) and of owners and members who may now only view the
   * project (`4412`). Other connections stay as they are, also if their user may now do more. If
   * the backend no longer has the project, the room is closed like for a close notification. Does
   * nothing, without asking the backend, if the room has no connections.
   *
   * @throws AccessError (`503`) if the members could not be loaded
   */
  async function checkRoom(roomName: string, projectId: string): Promise<void> {
    // Only connections accepted before the backend is asked are compared with its answer: one
    // accepted meanwhile may have fetched a newer state, e.g. after the user was added again.
    const targets: [WebSocket, Connection][] = [];
    for (const client of webSockets.clients) {
      const connection = connections.get(client);
      if (connection?.roomName === roomName && isActive(client, connection)) {
        targets.push([client, connection]);
      }
    }
    if (targets.length === 0) {
      return;
    }
    let members: Map<string, Role>;
    try {
      members = await options.backend.getMembers(projectId);
    } catch (error) {
      if (error instanceof BackendError && error.status === 404) {
        // The project is in the trash or deleted, and its close notification may have been lost.
        await closeRemovedProject(roomName);
        return;
      }
      throw new AccessError(503, `The access could not be checked: ${describeError(error)}`);
    }
    /** Number of closed connections, by user and reason. */
    const closed = new Map<string, number>();
    for (const [client, connection] of targets) {
      if (!isActive(client, connection)) {
        continue;
      }
      const role = members.get(connection.userId);
      let reason: string;
      if (role === undefined) {
        retire(client, connection, ACCESS_REVOKED_CLOSE_CODE, 'Access revoked');
        reason = 'access revoked';
      } else if (connection.role !== 'VIEWER' && role === 'VIEWER') {
        retire(client, connection, ROLE_CHANGED_CLOSE_CODE, 'Role changed');
        reason = 'role changed';
      } else {
        continue;
      }
      const key = `of user ${connection.userId} to ${roomName}: ${reason}`;
      closed.set(key, (closed.get(key) ?? 0) + 1);
    }
    // IDs only: never a token or an email address.
    for (const [key, count] of closed) {
      console.log(`Closed ${count} connection(s) ${key}`);
    }
  }

  /**
   * Drops the room of a project that was moved to the trash or deleted and closes its connections
   * with `4410`, once the backend confirmed that it no longer has the project (see `Rooms.remove`).
   *
   * @throws AccessError (`503`) if the backend could not be asked
   */
  async function closeRemovedProject(roomName: string): Promise<void> {
    let removed: boolean;
    try {
      removed = await rooms.remove(roomName);
    } catch (error) {
      throw new AccessError(503, `The removal could not be confirmed: ${describeError(error)}`);
    }
    if (!removed) {
      return;
    }
    // Only after the room was dropped, so that the clients leaving start no writeback.
    for (const client of webSockets.clients) {
      const connection = connections.get(client);
      if (connection?.roomName === roomName) {
        retire(client, connection, PROJECT_REMOVED_CLOSE_CODE, 'Project removed');
      }
    }
  }

  /** Whether a joined connection is open and was not closed by the server. */
  function isActive(client: WebSocket, connection: Connection): boolean {
    return client.readyState === client.OPEN && connection.guard.permission !== 'none';
  }

  /**
   * Closes a joined connection from the server's side. Its messages are dropped from now on, also
   * those ws still emits while the connection is closing: otherwise their changes would reach the
   * room and be written back. The connection is terminated if the client doesn't complete the
   * close within `revokedCloseTimeoutMs`. Does nothing for a connection closed this way before.
   */
  function retire(client: WebSocket, connection: Connection, code: number, reason: string): void {
    if (connection.guard.permission === 'none') {
      return;
    }
    connection.guard.restrict('none');
    if (client.readyState === client.CLOSED) {
      return;
    }
    client.close(code, reason);
    // ws 8.22 has a `closeTimeout` option for this, but its types don't have it yet.
    const timer = setTimeout(() => client.terminate(), revokedCloseTimeoutMs);
    timer.unref();
    client.once('close', () => clearTimeout(timer));
  }

  /** Makes joins in progress fetch the user's access again before they are accepted. */
  function markStale(joins: Set<PendingJoin> | undefined): void {
    for (const join of joins ?? []) {
      join.stale = true;
    }
  }

  /**
   * Checks a notification of the backend and returns the name of the project's room.
   *
   * @throws TokenError if the token isn't the backend's, AccessError (`400`) if the ID is invalid
   */
  async function checkNotification(
    projectId: string,
    authorization: string | undefined,
  ): Promise<string> {
    await options.backendTokens.verify(authorization);
    const roomName = `vsum:${projectId}`;
    parseRoomName(roomName);
    return roomName;
  }
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
    const { roomName, projectId, token, epoch } = parseRequest(request);
    // Registered before the backend is asked, so that a check of the room's access that arrives
    // while this connection is checked or loading makes it ask again.
    const pending: PendingJoin = { stale: false };
    let joins = pendingJoins.get(roomName);
    if (joins === undefined) {
      joins = new Set();
      pendingJoins.set(roomName, joins);
    }
    joins.add(pending);
    try {
      await admit(request, socket, head, { roomName, projectId, token, epoch }, pending);
    } finally {
      joins.delete(pending);
      if (joins.size === 0) {
        pendingJoins.delete(roomName);
      }
    }
  }

  /**
   * Checks the user's access, joins the room and accepts the connection. If a check of the room's
   * access arrived meanwhile (`pending.stale`), the access is fetched again first. The connection
   * is accepted and closed right away, without joining, if its document is outdated (`4409`), its
   * user has no access anymore (`4403`) or its project was removed meanwhile (`4410`).
   *
   * @throws AccessError if the connection must be rejected
   */
  async function admit(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    { roomName, projectId, token, epoch }: ConnectionRequest,
    pending: PendingJoin,
  ): Promise<void> {
    let access = await fetchAccess(projectId, token, options);
    let room: JoinedRoom;
    try {
      room = await joinRoom(roomName, projectId, epoch);
    } catch (error) {
      if (!(error instanceof OutdatedDocumentError)) {
        throw error;
      }
      const code = OUTDATED_DOCUMENT_CLOSE_CODE;
      closeWithoutJoining(request, socket, head, roomName, code, 'Outdated document');
      return;
    }
    // The raw socket closes in every case: when the WebSocket closes, and also when the upgrade
    // below is aborted without ever creating one (e.g. the client went away while loading).
    socket.once('close', room.release);
    // The backend took access away from someone meanwhile: the access fetched above may be older
    // than that, so it is fetched again with the client's token.
    while (pending.stale && !socket.destroyed) {
      pending.stale = false;
      try {
        access = await fetchAccess(projectId, token, options);
      } catch (error) {
        room.release();
        if (error instanceof AccessError && error.status === 403) {
          const code = ACCESS_REVOKED_CLOSE_CODE;
          closeWithoutJoining(request, socket, head, roomName, code, 'Access revoked');
          return;
        }
        throw error;
      }
    }
    if (socket.destroyed) {
      room.release();
      return;
    }
    if (closing) {
      room.release();
      throw new AccessError(503, 'The server is shutting down');
    }
    if (room.dropped) {
      // The room was dropped while the access was fetched again, and may have been opened again
      // since. Apart from shutting down, only a removed project drops a room that has users.
      room.release();
      const code = PROJECT_REMOVED_CLOSE_CODE;
      closeWithoutJoining(request, socket, head, roomName, code, 'Project removed');
      return;
    }
    const { role, userId } = access;
    // The callback runs right away, so no check can come between the last one above and the
    // connection being registered.
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      // ws reports invalid frames as errors and then closes the connection. Without a listener, the
      // error would crash the server. Only the message is logged: the request URL has the token.
      webSocket.on('error', (error) => {
        console.error(`A connection to ${roomName} failed:`, error.message);
      });
      const guard = guardMessages(webSocket, role === 'VIEWER' ? 'read' : 'write');
      connections.set(webSocket, { roomName, userId, role, guard });
      setupWSConnection(webSocket, request, { docName: roomName });
    });
  }

  /**
   * Accepts a connection and closes it right away with `code`, without joining the room: nothing of
   * the room's document reaches the client, and nothing of the client's document reaches the room.
   * Browsers can read close codes, but not the status of a rejected handshake.
   */
  function closeWithoutJoining(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    roomName: string,
    code: number,
    reason: string,
  ): void {
    // ws destroys a socket that went away meanwhile instead of upgrading it.
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      // Messages are never read. Without an error listener, an invalid frame sent before the close
      // would crash the server.
      webSocket.on('error', (error) => {
        console.error(`A connection to ${roomName} failed:`, error.message);
      });
      webSocket.close(code, reason);
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
      if (
        error instanceof ProjectRemovedError ||
        (error instanceof BackendError && error.status === 404)
      ) {
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
 * Reads room name, token and epoch from the request URL.
 *
 * @throws AccessError (`400`) if the URL or the room name is invalid
 */
function parseRequest(request: IncomingMessage): ConnectionRequest {
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
  return { roomName, projectId: parseRoomName(roomName), token, epoch };
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

/** The backend's notifications about a project, by the last segment of their path. */
type ProjectNotification = 'reload' | 'close' | 'check-access';

/** The backend's notifications: those about a project, and the one about a user. */
type Notification = ProjectNotification | 'check-user-access';

/** The text of the `202` answer to each notification. */
const ACCEPTED: Record<Notification, string> = {
  reload: 'Reloading',
  close: 'Closed',
  'check-access': 'Checked',
  'check-user-access': 'Checked',
};

const PROJECT_NOTIFICATION = /^\/internal\/projects\/([^/]+)\/(reload|close|check-access)$/;
const USER_NOTIFICATION = /^\/internal\/users\/([^/]+)\/check-access$/;

/** Returns the notification a path names and the project or user ID in it, if it names one. */
function route(path: string): { notification: Notification; id: string } | undefined {
  const project = PROJECT_NOTIFICATION.exec(path);
  if (project !== null) {
    return { notification: project[2] as ProjectNotification, id: project[1] };
  }
  const user = USER_NOTIFICATION.exec(path);
  return user === null ? undefined : { notification: 'check-user-access', id: user[1] };
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  notifications: Record<
    Notification,
    (id: string, authorization: string | undefined) => Promise<void>
  >,
): void {
  // The body isn't used; reading it lets the connection be reused.
  request.resume();
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'UP' }));
    return;
  }
  let path: string;
  try {
    path = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    answer(response, 400, 'Bad request');
    return;
  }
  const match = route(path);
  if (match === undefined) {
    answer(response, 404, 'Not found');
    return;
  }
  if (request.method !== 'POST') {
    answer(response, 405, 'Method not allowed', { Allow: 'POST' });
    return;
  }
  const { notification, id } = match;
  // Not decoded: a valid project or user ID has digits only, and anything else is rejected with 400.
  notifications[notification](id, request.headers.authorization).then(
    () => answer(response, 202, ACCEPTED[notification]),
    (error: unknown) => {
      const status = error instanceof TokenError || error instanceof AccessError ? error.status : 500;
      // Only the message is logged, never the header: it contains the token.
      console.error(`Rejected a ${notification} notification:`, describeError(error));
      answer(response, status, STATUS_CODES[status] ?? 'Error', status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
    },
  );
}

function answer(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
  response.end(text);
}
