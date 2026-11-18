import { startFakeServer, type FakeAnswer, type FakeServer } from './fakeServer.js';

export const REALM = 'methodologist';
export const CLIENT_ID = 'collaboration-service';
export const CLIENT_SECRET = 'test-secret';
export const TOKEN_PATH = `/realms/${REALM}/protocol/openid-connect/token`;

export interface FakeKeycloak extends FakeServer {
  /** Answers the next token requests with these, in order, instead of issuing tokens. */
  answerNext(...answers: FakeAnswer[]): void;
}

/**
 * Starts an HTTP server that stands in for Keycloak. It only knows the token endpoint of
 * {@link REALM} and, for the client credentials grant with {@link CLIENT_ID} and
 * {@link CLIENT_SECRET}, issues the tokens `token-1`, `token-2`, ... valid for `expiresIn` seconds.
 * Other credentials get `401` like from the real Keycloak.
 */
export async function startFakeKeycloak(expiresIn = 300): Promise<FakeKeycloak> {
  const queued: FakeAnswer[] = [];
  let issued = 0;
  const server = await startFakeServer((request) => {
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
  return { ...server, answerNext: (...answers) => queued.push(...answers) };
}
