import { describeError } from './errors.js';

/** Role of a user in a project, as returned by the backend. */
export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';

const ROLES: readonly string[] = ['OWNER', 'MEMBER', 'VIEWER'];

/** Whether a value from the backend is a known {@link Role}. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.includes(value);
}

/** How long the backend may take to answer before the connection is rejected with `503`. */
export const DEFAULT_BACKEND_TIMEOUT_MS = 5000;

// At most 18 digits, so the ID always fits into the backend's `Long`. No leading zeros, so that
// each project has one room: `vsum:012` would be a second room for project 12.
const ROOM_NAME = /^vsum:(0|[1-9]\d{0,17})$/;
// The same rule for user IDs, so that each user has one ID.
const USER_ID = /^(0|[1-9]\d{0,17})$/;

/** Why a connection is rejected. `status` is the HTTP status the client gets. */
export class AccessError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

/**
 * Returns the project ID of a room name like `vsum:12`.
 *
 * @throws AccessError with status `400` if the room name has another form
 */
export function parseRoomName(roomName: string): string {
  const match = ROOM_NAME.exec(roomName);
  if (match === null) {
    throw new AccessError(400, 'The room name must be vsum:{id} with a numeric ID without leading zeros');
  }
  return match[1];
}

/**
 * Checks a user ID of the backend, e.g. `7`, and returns it.
 *
 * @throws AccessError with status `400` if it isn't a numeric ID without leading zeros
 */
export function parseUserId(userId: string): string {
  if (!USER_ID.test(userId)) {
    throw new AccessError(400, 'The user ID must be numeric without leading zeros');
  }
  return userId;
}

export interface BackendOptions {
  /** Base URL of the backend without a trailing slash, e.g. `http://localhost:9811`. */
  backendUrl: string;
  /** Defaults to {@link DEFAULT_BACKEND_TIMEOUT_MS}. */
  backendTimeoutMs?: number;
}

/** What a user may do in a project, and who the user is. */
export interface UserAccess {
  role: Role;
  /** The backend's ID of the user (`usr.id`) as a decimal string, e.g. `7`. */
  userId: string;
}

/**
 * Asks the backend for the role the owner of the access token has in the project, and for the
 * user's ID (`GET /api/v1/vsums/{id}/details`). The ID identifies the user's connections when the
 * backend takes access away later.
 *
 * @throws AccessError with status `401` if the token is missing or not accepted, `403` if the user
 *     has no access to the project (or it doesn't exist), and `503` if the backend fails, doesn't
 *     answer in time or answers without a known role or without a valid user ID
 */
export async function fetchAccess(
  projectId: string,
  token: string | null,
  { backendUrl, backendTimeoutMs = DEFAULT_BACKEND_TIMEOUT_MS }: BackendOptions,
): Promise<UserAccess> {
  if (token === null || token === '') {
    throw new AccessError(401, 'The access token is missing');
  }

  let status: number;
  let body: unknown;
  try {
    const response = await fetch(`${backendUrl}/api/v1/vsums/${projectId}/details`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      // Never follow a redirect: it would send the token to another address.
      redirect: 'manual',
      signal: AbortSignal.timeout(backendTimeoutMs),
    });
    status = response.status;
    if (status === 200) {
      body = await response.json();
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    throw new AccessError(503, `The backend is not available: ${describeError(error)}`);
  }

  if (status === 401) {
    throw new AccessError(401, 'The backend did not accept the access token');
  }
  if (status === 403 || status === 404) {
    throw new AccessError(403, 'The user has no access to the project');
  }
  if (status !== 200) {
    throw new AccessError(503, `The backend answered with status ${status}`);
  }
  const data = (body as { data?: { role?: unknown; userId?: unknown } } | null)?.data;
  const role = data?.role;
  if (!isRole(role)) {
    throw new AccessError(503, 'The backend answered without a known role');
  }
  // Without the ID, the connection could not be closed when the user loses access: rejected.
  const userId = data?.userId;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 0) {
    throw new AccessError(503, "The backend answered without the user's ID");
  }
  return { role, userId: String(userId) };
}
