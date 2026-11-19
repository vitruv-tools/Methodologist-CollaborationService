import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import { describeError } from './errors.js';

/** Realm role of the backend's service account, required to call the server's internal endpoints. */
export const BACKEND_ROLE = 'methodologist-backend';

/** How long Keycloak may take to answer for its public keys. */
export const DEFAULT_KEYS_TIMEOUT_MS = 5000;

/**
 * Why a request from the backend is rejected. `status` is the HTTP status of the answer. The
 * message never contains the token.
 */
export class TokenError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

/** Checks the tokens the backend calls the server's internal endpoints with. */
export interface BackendTokenVerifier {
  /**
   * Checks the `Authorization` header of a request: a Bearer token that Keycloak's realm issued,
   * signed with one of its keys, not expired, with the realm role {@link BACKEND_ROLE}.
   *
   * @throws TokenError with status `401` if the token is missing, invalid or expired, `403` if it
   *     lacks the role, and `503` if Keycloak's public keys can't be fetched
   */
  verify(authorization: string | undefined): Promise<void>;
}

export interface BackendTokenOptions {
  /** Base URL of Keycloak without a trailing slash, the same the backend gets its token from. */
  url: string;
  realm: string;
  /** Defaults to {@link DEFAULT_KEYS_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Errors of `jose` that mean the token is invalid, as opposed to Keycloak's keys being unavailable.
 * Any other error (a timeout, a failed request, an invalid answer) means the latter.
 */
const INVALID_TOKEN_ERRORS = [
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/**
 * Creates the verifier of the backend's tokens. Keycloak's public keys are fetched from its certs
 * endpoint when first needed and cached; they are fetched again when a token names an unknown key.
 *
 * The issuer of a token is the Keycloak URL its client got it from, so `url` must be the URL the
 * backend uses, otherwise every token is rejected with `401`.
 */
export function createBackendTokenVerifier(options: BackendTokenOptions): BackendTokenVerifier {
  const { url, realm, timeoutMs = DEFAULT_KEYS_TIMEOUT_MS } = options;
  const issuer = `${url}/realms/${realm}`;
  const keys = createRemoteJWKSet(
    new URL(`${url}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`),
    { timeoutDuration: timeoutMs },
  );

  return {
    async verify(authorization) {
      const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
      if (token === undefined) {
        throw new TokenError(401, 'The access token is missing');
      }
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, { issuer }));
      } catch (error) {
        if (INVALID_TOKEN_ERRORS.some((type) => error instanceof type)) {
          throw new TokenError(401, `The access token is not valid: ${describeError(error)}`);
        }
        throw new TokenError(503, `Keycloak's public keys are not available: ${describeError(error)}`);
      }
      const roles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
      if (!Array.isArray(roles) || !roles.includes(BACKEND_ROLE)) {
        throw new TokenError(403, `The access token lacks the role ${BACKEND_ROLE}`);
      }
    },
  };
}
