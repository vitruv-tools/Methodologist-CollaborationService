import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceToken,
  ServiceTokenError,
  type ServiceToken,
  type ServiceTokenOptions,
} from '../src/serviceToken.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  REALM,
  startFakeKeycloak,
  TOKEN_PATH,
  type FakeKeycloak,
} from './fakeKeycloak.js';

const LIFETIME_S = 300;

let keycloak: FakeKeycloak;
let time: number;

beforeEach(async () => {
  keycloak = await startFakeKeycloak(LIFETIME_S);
  time = 1_000_000;
});

afterEach(async () => {
  await keycloak.close();
});

function serviceToken(options: Partial<ServiceTokenOptions> = {}): ServiceToken {
  return createServiceToken({
    url: keycloak.url,
    realm: REALM,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    timeoutMs: 300,
    now: () => time,
    ...options,
  });
}

/** Resolves with the error `promise` is rejected with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('The promise was not rejected');
}

describe('getting a token', () => {
  it('asks Keycloak with the client credentials grant', async () => {
    expect(await serviceToken().get()).toBe('token-1');

    expect(keycloak.requests).toHaveLength(1);
    const [request] = keycloak.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe(TOKEN_PATH);
    expect(request.contentType).toContain('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it('reuses the token until 30 seconds before it expires', async () => {
    const tokens = serviceToken();
    expect(await tokens.get()).toBe('token-1');

    time += (LIFETIME_S - 30) * 1000 - 1;
    expect(await tokens.get()).toBe('token-1');
    expect(keycloak.requests).toHaveLength(1);

    time += 1;
    expect(await tokens.get()).toBe('token-2');
    expect(keycloak.requests).toHaveLength(2);
  });

  it('asks Keycloak only once for callers that ask at the same time', async () => {
    const tokens = serviceToken();

    expect(await Promise.all([tokens.get(), tokens.get(), tokens.get()])).toEqual([
      'token-1',
      'token-1',
      'token-1',
    ]);
    expect(keycloak.requests).toHaveLength(1);
  });

  it('asks again after a failure', async () => {
    const tokens = serviceToken();
    keycloak.answerNext({ status: 500 });

    await expect(tokens.get()).rejects.toBeInstanceOf(ServiceTokenError);
    expect(await tokens.get()).toBe('token-1');
  });
});

describe('renewing a rejected token', () => {
  it('gets a new token, also before the old one expires', async () => {
    const tokens = serviceToken();
    await tokens.get();

    expect(await tokens.renew('token-1')).toBe('token-2');
    expect(await tokens.get()).toBe('token-2');
    expect(keycloak.requests).toHaveLength(2);
  });

  it('does not ask Keycloak again if the token was already renewed', async () => {
    const tokens = serviceToken();
    await tokens.get();
    await tokens.renew('token-1');

    expect(await tokens.renew('token-1')).toBe('token-2');
    expect(keycloak.requests).toHaveLength(2);
  });
});

describe('failures', () => {
  it('rejects a wrong secret without naming it', async () => {
    const error = await failure(serviceToken({ clientSecret: 'wrong-secret' }).get());

    expect(error).toBeInstanceOf(ServiceTokenError);
    expect(error.message).toBe('Keycloak answered with status 401 (unauthorized_client)');
  });

  it.each([
    ['an error', { status: 500 }, 'Keycloak answered with status 500'],
    ['no JSON', { status: 200, body: '<html>' }, 'without a token'],
    ['no token', { status: 200, body: { expires_in: 300 } }, 'without a token'],
    ['no lifetime', { status: 200, body: { access_token: 'token' } }, 'without a token'],
  ])('fails if Keycloak answers with %s', async (_name, answer, message) => {
    keycloak.answerNext(answer);

    const error = await failure(serviceToken().get());

    expect(error).toBeInstanceOf(ServiceTokenError);
    expect(error.message).toContain(message);
  });

  it('fails if Keycloak does not answer in time', async () => {
    keycloak.answerNext('hang');

    const error = await failure(serviceToken().get());

    expect(error).toBeInstanceOf(ServiceTokenError);
    expect(error.message).toContain('Keycloak is not available');
  });

  it('fails if Keycloak is not reachable', async () => {
    const url = keycloak.url;
    await keycloak.close();

    const error = await failure(serviceToken({ url }).get());

    expect(error).toBeInstanceOf(ServiceTokenError);
    expect(error.message).toContain('Keycloak is not available');
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
});
