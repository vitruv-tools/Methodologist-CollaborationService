/** Role of a user in a project, as returned by the backend. */
export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';

const ROLES: readonly string[] = ['OWNER', 'MEMBER', 'VIEWER'];

/** How long the backend may take to answer before the connection is rejected with `503`. */
export const DEFAULT_BACKEND_TIMEOUT_MS = 5000;

// At most 18 digits, so the ID always fits into the backend's `Long`.
const ROOM_NAME = /^vsum:(\d{1,18})$/;

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
    throw new AccessError(400, 'The room name must be vsum:{id} with a numeric ID');
  }
  return match[1];
}

export interface BackendOptions {
  /** Base URL of the backend without a trailing slash, e.g. `http://localhost:9811`. */
  backendUrl: string;
  /** Defaults to {@link DEFAULT_BACKEND_TIMEOUT_MS}. */
  backendTimeoutMs?: number;
}

/**
 * Asks the backend for the role the owner of the access token has in the project.
 *
 * @throws AccessError with status `401` if the token is missing or not accepted, `403` if the user
 *     has no access to the project (or it doesn't exist), and `503` if the backend fails or
 *     doesn't answer in time
 */
export async function fetchRole(
  projectId: string,
  token: string | null,
  { backendUrl, backendTimeoutMs = DEFAULT_BACKEND_TIMEOUT_MS }: BackendOptions,
): Promise<Role> {
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
    throw new AccessError(503, `The backend is not available: ${describe(error)}`);
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
  const role = (body as { data?: { role?: unknown } } | null)?.data?.role;
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    throw new AccessError(503, 'The backend answered without a known role');
  }
  return role as Role;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  // fetch reports network problems as "fetch failed" and puts the reason into `cause`.
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
