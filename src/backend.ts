import { isRole, type Role } from './access.js';
import { describeError } from './errors.js';
import type { ServiceToken } from './serviceToken.js';

/** How long a request to an internal endpoint may take. Writing changes back can take a while. */
export const DEFAULT_INTERNAL_TIMEOUT_MS = 30_000;

/** A metamodel of a project, or one a view uses (`MetaModelResponse`). */
export interface MetaModelDetails {
  /** ID of the project's own copy of the metamodel. */
  id: number;
  /** ID of the metamodel in the model library that the copy was made from. Sync requests use it. */
  sourceId?: number | null;
  /** Name of the metamodel in the project. */
  name?: string | null;
  [field: string]: unknown;
}

/**
 * An element-level mapping under a relation (`FineGranularMetaModelRelationResponse`). The request
 * (`FineGranularMetaModelRelationRequest`) has the same fields, so these are sent back as they are.
 */
export interface FineGranularDetails {
  id?: number | null;
  sourceId?: string | null;
  targetId?: string | null;
  reactionFileStorageId?: number | null;
  lowCodeReactionRequestBase?: unknown;
  [field: string]: unknown;
}

/** A relation between two metamodels (`MetaModelRelationResponse`), with library metamodel IDs. */
export interface RelationDetails {
  id: number;
  sourceId: number;
  targetId: number;
  reactionFileStorageId?: number | null;
  fineGranularMetaModelRelationSet?: FineGranularDetails[] | null;
}

/** A view of a project (`ViewsResponse`). */
export interface ViewDetails {
  id: number;
  name?: string | null;
  description?: string | null;
  fileStorageId?: number | null;
  assignedModels?: MetaModelDetails[] | null;
  [field: string]: unknown;
}

/** A project as the backend returns it (`VsumMetaModelResponse`). */
export interface ProjectDetails {
  id: number;
  name: string;
  metaModels?: MetaModelDetails[] | null;
  metaModelsRelation?: RelationDetails[] | null;
  views?: ViewDetails[] | null;
  /** The canvas positions, stored by the backend without interpreting them; `null` if none. */
  layout?: unknown;
  [field: string]: unknown;
}

/** A relation in a sync request (`MetaModelRelationRequest`). */
export interface RelationRequest {
  sourceId: number;
  targetId: number;
  reactionFileId: number | null;
  fineGranularMetaModelRelationSet: FineGranularDetails[];
}

/** A view in a sync request (`ViewRequest`). */
export interface ViewRequest {
  /** ID of the existing view. Without it, the backend finds the view by its name. */
  id?: number;
  name: string;
  description: string;
  fileStorageId: number | null;
  metaModelIds: number[];
}

/**
 * The desired state of a project, as the backend expects it (`VsumSyncChangesPutRequest`). The
 * backend deletes what the request doesn't contain, except the layout: without one, it keeps the
 * stored layout.
 */
export interface SyncChanges {
  /** Library IDs of the project's metamodels. */
  metaModelIds: number[];
  /** Names of the metamodels in the project, by library ID. */
  metaModelNames: Record<string, string>;
  metaModelRelationRequests: RelationRequest[];
  viewRequests: ViewRequest[];
  layout?: Record<string, unknown>;
}

/**
 * Why a request to the backend failed. `status` is the backend's HTTP status, or `undefined` if
 * the backend didn't answer. `detail` is the `message` of the backend's error answer, if it has
 * one, e.g. why a sync request is invalid. Neither contains a token.
 */
export class BackendError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/** Calls the backend's internal endpoints with the collaboration server's service account. */
export interface BackendClient {
  /**
   * Loads a project, for any project and without a user.
   *
   * @throws BackendError if the backend fails or answers with an error
   * @throws ServiceTokenError if no token can be got from Keycloak
   */
  getProject(projectId: string): Promise<ProjectDetails>;
  /**
   * Writes the desired state of a project back.
   *
   * @throws BackendError if the backend fails or answers with an error
   * @throws ServiceTokenError if no token can be got from Keycloak
   */
  syncChanges(projectId: string, changes: SyncChanges): Promise<void>;
  /**
   * Loads the role of every active user of a project, by the user's ID as a decimal string (the
   * same IDs as in `GET /api/v1/vsums/{id}/details`). Users not in the map have no access.
   *
   * @throws BackendError with status `404` if the project doesn't exist or is in the trash; also
   *     if the backend fails, answers with another error or answers with an invalid list, which is
   *     never taken as an empty one
   * @throws ServiceTokenError if no token can be got from Keycloak
   */
  getMembers(projectId: string): Promise<Map<string, Role>>;
}

export interface BackendClientOptions {
  /** Base URL of the backend without a trailing slash, e.g. `http://localhost:9811`. */
  backendUrl: string;
  serviceToken: ServiceToken;
  /** Defaults to {@link DEFAULT_INTERNAL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Creates the client of the backend's internal endpoints. Every request carries the service token.
 * If the backend rejects the token with `401`, the token is renewed once and the request is
 * retried once.
 */
export function createBackendClient(options: BackendClientOptions): BackendClient {
  const { backendUrl, serviceToken, timeoutMs = DEFAULT_INTERNAL_TIMEOUT_MS } = options;

  async function send(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const call = (token: string) => request(`${backendUrl}${path}`, method, token, body, timeoutMs);
    const token = await serviceToken.get();
    let response = await call(token);
    if (response.status === 401) {
      response = await call(await serviceToken.renew(token));
    }
    if (!response.ok) {
      throw new BackendError(
        response.status,
        `The backend answered ${method} ${path} with status ${response.status}`,
        response.detail,
      );
    }
    return response.body;
  }

  const projectPath = (projectId: string) =>
    `/api/internal/v1/vsums/${encodeURIComponent(projectId)}`;

  return {
    async getProject(projectId) {
      const body = await send('GET', `${projectPath(projectId)}/details`);
      const project = (body as { data?: unknown } | undefined)?.data;
      if (typeof project !== 'object' || project === null) {
        throw new BackendError(200, `The backend answered without project ${projectId}`);
      }
      return project as ProjectDetails;
    },
    async syncChanges(projectId, changes) {
      await send('PUT', `${projectPath(projectId)}/sync-changes`, changes);
    },
    async getMembers(projectId) {
      const body = await send('GET', `${projectPath(projectId)}/members`);
      const list = (body as { data?: unknown } | undefined)?.data;
      if (!Array.isArray(list)) {
        throw new BackendError(200, `The backend answered without the members of project ${projectId}`);
      }
      const members = new Map<string, Role>();
      for (const entry of list) {
        const { userId, role } = (entry ?? {}) as { userId?: unknown; role?: unknown };
        if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 0 || !isRole(role)) {
          throw new BackendError(200, `The backend answered with an invalid member of project ${projectId}`);
        }
        members.set(String(userId), role);
      }
      return members;
    },
  };
}

/** Longest `detail` taken from an error answer; the rest is cut off. */
const MAX_DETAIL_LENGTH = 500;

interface Answer {
  status: number;
  ok: boolean;
  /** Parsed JSON body of a successful answer; `undefined` if it has none. */
  body: unknown;
  /** The `message` of an error answer, if it has one. */
  detail?: string;
}

async function request(
  url: string,
  method: 'GET' | 'PUT',
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<Answer> {
  // Outside the try: a body that isn't JSON is a mistake of the caller, not an unavailable backend.
  const payload = body === undefined ? undefined : JSON.stringify(body);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload,
      // Never follow a redirect: it would send the token to another address.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => undefined);
      return { status: response.status, ok: false, body: undefined, detail: errorMessage(error) };
    }
    const json: unknown = await response.json().catch(() => undefined);
    return { status: response.status, ok: true, body: json };
  } catch (error) {
    throw new BackendError(undefined, `The backend is not available: ${describeError(error)}`);
  }
}

/** Returns the `message` of the backend's error answer (`ErrorResponse`), if it has one. */
function errorMessage(body: unknown): string | undefined {
  const message = (body as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string' || message.trim() === '') {
    return undefined;
  }
  const trimmed = message.trim();
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed;
}
