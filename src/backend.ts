import { describeError } from './errors.js';
import type { ServiceToken } from './serviceToken.js';

/** How long a request to an internal endpoint may take. Writing changes back can take a while. */
export const DEFAULT_INTERNAL_TIMEOUT_MS = 30_000;

/**
 * A project as the backend returns it (`VsumMetaModelResponse`). Only the top level is typed; the
 * issue that loads projects into the shared document types the rest.
 */
export interface ProjectDetails {
  id: number;
  name: string;
  metaModels?: unknown[];
  metaModelsRelation?: unknown[];
  views?: unknown[];
  layout?: unknown;
  [field: string]: unknown;
}

/** The desired state of a project, as the backend expects it (`VsumSyncChangesPutRequest`). */
export interface SyncChanges {
  metaModelIds?: number[];
  metaModelNames?: Record<string, string>;
  metaModelRelationRequests?: unknown[];
  viewRequests?: unknown[];
  layout?: unknown;
}

/**
 * Why a request to the backend failed. `status` is the backend's HTTP status, or `undefined` if
 * the backend didn't answer. The message never contains a token.
 */
export class BackendError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
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
  };
}

interface Answer {
  status: number;
  ok: boolean;
  /** Parsed JSON body of a successful answer; `undefined` if it has none. */
  body: unknown;
}

async function request(
  url: string,
  method: 'GET' | 'PUT',
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<Answer> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow a redirect: it would send the token to another address.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, ok: false, body: undefined };
    }
    const json: unknown = await response.json().catch(() => undefined);
    return { status: response.status, ok: true, body: json };
  } catch (error) {
    throw new BackendError(undefined, `The backend is not available: ${describeError(error)}`);
  }
}
