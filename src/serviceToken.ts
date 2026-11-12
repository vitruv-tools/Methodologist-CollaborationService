import type { KeycloakConfig } from './config.js';
import { describeError } from './errors.js';

/** A token is renewed this long before it expires, so it can't expire on its way to the backend. */
export const RENEW_BEFORE_EXPIRY_MS = 30_000;

/** How long Keycloak may take to answer before getting a token fails. */
export const DEFAULT_KEYCLOAK_TIMEOUT_MS = 5000;

/** Why no token could be got from Keycloak. The message never contains the secret or a token. */
export class ServiceTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceTokenError';
  }
}

/** The access token of the collaboration server's own service account. */
export interface ServiceToken {
  /**
   * Returns a token that is valid for at least {@link RENEW_BEFORE_EXPIRY_MS}: the one in memory,
   * or a new one from Keycloak.
   *
   * @throws ServiceTokenError if Keycloak doesn't give one
   */
  get(): Promise<string>;
  /**
   * Returns a new token after the backend rejected `rejected`. If the token was already renewed in
   * the meantime, that one is returned without asking Keycloak again.
   *
   * @throws ServiceTokenError if Keycloak doesn't give one
   */
  renew(rejected: string): Promise<string>;
}

export interface ServiceTokenOptions extends KeycloakConfig {
  /** Defaults to {@link DEFAULT_KEYCLOAK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Current time in milliseconds. Defaults to `Date.now`; tests replace it. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  /** Time after which the token is renewed instead of reused. */
  renewAt: number;
}

/**
 * Gets the service account's token from Keycloak with the client credentials grant and keeps it
 * in memory until shortly before it expires. Concurrent callers share one request to Keycloak.
 */
export function createServiceToken(options: ServiceTokenOptions): ServiceToken {
  const now = options.now ?? Date.now;
  let cached: CachedToken | undefined;
  let pending: Promise<string> | undefined;

  const isValid = (token: CachedToken | undefined): token is CachedToken =>
    token !== undefined && now() < token.renewAt;

  function requestNewToken(): Promise<string> {
    pending ??= requestToken(options, now)
      .then((token) => {
        cached = token;
        return token.token;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return {
    get: () => (isValid(cached) ? Promise.resolve(cached.token) : requestNewToken()),
    renew: (rejected) => {
      if (isValid(cached) && cached.token !== rejected) {
        return Promise.resolve(cached.token);
      }
      // Callers that ask meanwhile wait for the new token instead of getting the rejected one.
      cached = undefined;
      return requestNewToken();
    },
  };
}

async function requestToken(options: ServiceTokenOptions, now: () => number): Promise<CachedToken> {
  const { url, realm, clientId, clientSecret, timeoutMs = DEFAULT_KEYCLOAK_TIMEOUT_MS } = options;
  const requestedAt = now();
  let status: number;
  let body: unknown;
  try {
    const response = await fetch(
      `${url}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        // Never follow a redirect: it would send the secret to another address.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    status = response.status;
    body = await response.json().catch(() => undefined);
  } catch (error) {
    throw new ServiceTokenError(`Keycloak is not available: ${describeError(error)}`);
  }

  if (status !== 200) {
    // Keycloak names the reason in `error`, e.g. `unauthorized_client` for a wrong secret.
    const reason = (body as { error?: unknown } | undefined)?.error;
    const detail = typeof reason === 'string' ? ` (${reason})` : '';
    throw new ServiceTokenError(`Keycloak answered with status ${status}${detail}`);
  }
  const { access_token: token, expires_in: expiresIn } =
    (body as { access_token?: unknown; expires_in?: unknown } | undefined) ?? {};
  const hasToken = typeof token === 'string' && token !== '';
  if (!hasToken || typeof expiresIn !== 'number' || expiresIn <= 0) {
    throw new ServiceTokenError('Keycloak answered without a token or its lifetime');
  }
  return { token, renewAt: requestedAt + expiresIn * 1000 - RENEW_BEFORE_EXPIRY_MS };
}
