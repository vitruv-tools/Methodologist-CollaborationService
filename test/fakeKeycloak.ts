import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import { startFakeServer, type FakeAnswer, type FakeServer } from './fakeServer.js';

export const REALM = 'methodologist';
export const CLIENT_ID = 'collaboration-service';
export const CLIENT_SECRET = 'test-secret';
export const TOKEN_PATH = `/realms/${REALM}/protocol/openid-connect/token`;
/** Where Keycloak publishes the public keys its tokens are signed with. */
export const CERTS_PATH = `/realms/${REALM}/protocol/openid-connect/certs`;
/** ID of the key the fake Keycloak signs tokens with. */
export const KEY_ID = 'test-key';

export interface TokenOptions {
  /** Realm roles of the token, in `realm_access.roles`. Defaults to none. */
  roles?: string[];
  /** Defaults to the fake Keycloak's issuer, `{url}/realms/{REALM}`. */
  issuer?: string;
  /** Lifetime from now in seconds; negative for an expired token. Defaults to 300. */
  expiresIn?: number;
  /** Further claims. */
  claims?: JWTPayload;
  /** Signs with another key that has the same key ID, like a forged token. */
  forged?: boolean;
}

export interface FakeKeycloak extends FakeServer {
  /** Answers the next token requests with these, in order, instead of issuing tokens. */
  answerNext(...answers: FakeAnswer[]): void;
  /** Issues a signed access token like Keycloak's, e.g. for the backend's service account. */
  signToken(options?: TokenOptions): Promise<string>;
}

/**
 * Starts an HTTP server that stands in for Keycloak. It only knows two endpoints of {@link REALM}:
 *
 * - The token endpoint: for the client credentials grant with {@link CLIENT_ID} and
 *   {@link CLIENT_SECRET}, it issues the tokens `token-1`, `token-2`, ... valid for `expiresIn`
 *   seconds. Other credentials get `401` like from the real Keycloak.
 * - The certs endpoint ({@link CERTS_PATH}): the public key of a key pair generated at start, with
 *   which {@link FakeKeycloak.signToken} signs tokens.
 */
export async function startFakeKeycloak(expiresIn = 300): Promise<FakeKeycloak> {
  const queued: FakeAnswer[] = [];
  let issued = 0;
  const keys = await generateKeyPair('RS256');
  const forgedKeys = await generateKeyPair('RS256');
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };
  const server = await startFakeServer((request) => {
    if (request.method === 'GET' && request.path === CERTS_PATH) {
      return { status: 200, body: { keys: [publicKey] } };
    }
    if (request.method !== 'POST' || request.path !== TOKEN_PATH) {
      return { status: 404 };
    }
    const next = queued.shift();
    if (next !== undefined) {
      return next;
    }
    const params = new URLSearchParams(request.body);
    const isServiceAccount =
      params.get('grant_type') === 'client_credentials' &&
      params.get('client_id') === CLIENT_ID &&
      params.get('client_secret') === CLIENT_SECRET;
    if (!isServiceAccount) {
      return {
        status: 401,
        body: {
          error: 'unauthorized_client',
          error_description: 'Invalid client or Invalid client credentials',
        },
      };
    }
    issued += 1;
    return {
      status: 200,
      body: { access_token: `token-${issued}`, expires_in: expiresIn, token_type: 'Bearer' },
    };
  });

  async function signToken(options: TokenOptions = {}): Promise<string> {
    const privateKey: CryptoKey = options.forged ? forgedKeys.privateKey : keys.privateKey;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ realm_access: { roles: options.roles ?? [] }, ...options.claims })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(options.issuer ?? `${server.url}/realms/${REALM}`)
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresIn ?? 300))
      .sign(privateKey);
  }

  return { ...server, answerNext: (...answers) => queued.push(...answers), signToken };
}
