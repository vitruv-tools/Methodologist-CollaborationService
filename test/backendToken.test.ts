import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKEND_ROLE,
  createBackendTokenVerifier,
  TokenError,
  type BackendTokenVerifier,
} from '../src/backendToken.js';
import { CERTS_PATH, REALM, startFakeKeycloak, type FakeKeycloak } from './fakeKeycloak.js';
import { startFakeServer } from './fakeServer.js';

let keycloak: FakeKeycloak;
let verifier: BackendTokenVerifier;

beforeEach(async () => {
  keycloak = await startFakeKeycloak();
  verifier = createBackendTokenVerifier({ url: keycloak.url, realm: REALM, timeoutMs: 300 });
});

afterEach(async () => {
  await keycloak.close();
});

/** Resolves with the error `promise` is rejected with. */
async function failure(promise: Promise<unknown>): Promise<TokenError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TokenError);
    return error as TokenError;
  }
  throw new Error('The promise was not rejected');
}

const statusOf = async (authorization: string | undefined) =>
  (await failure(verifier.verify(authorization))).status;

describe('a valid token', () => {
  it("is accepted if it has the backend's realm role", async () => {
    const token = await keycloak.signToken({ roles: ['offline_access', BACKEND_ROLE] });

    await expect(verifier.verify(`Bearer ${token}`)).resolves.toBeUndefined();
  });

  it("is checked against Keycloak's keys, which are fetched once and reused", async () => {
    for (let i = 0; i < 3; i++) {
      await verifier.verify(`Bearer ${await keycloak.signToken({ roles: [BACKEND_ROLE] })}`);
    }

    expect(keycloak.requests.filter((request) => request.path === CERTS_PATH)).toHaveLength(1);
  });

  it('is rejected with 403 without the role', async () => {
    const withoutRole = await keycloak.signToken({ roles: ['user'] });
    const roleOfAClient = await keycloak.signToken({
      claims: { resource_access: { backend: { roles: [BACKEND_ROLE] } } },
    });
    const noRoleList = await keycloak.signToken({ claims: { realm_access: { roles: BACKEND_ROLE } } });

    for (const token of [withoutRole, roleOfAClient, noRoleList]) {
      expect(await statusOf(`Bearer ${token}`)).toBe(403);
    }
  });
});

describe('a token that is not valid', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['of another scheme', 'Basic dXNlcjpwYXNz'],
    ['without token', 'Bearer '],
    ['not a JWT', 'Bearer not-a-token'],
  ])('is rejected with 401 if the header is %s', async (_name, authorization) => {
    expect(await statusOf(authorization)).toBe(401);
  });

  it('is rejected with 401 if it is not signed by Keycloak', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE], forged: true });

    expect(await statusOf(`Bearer ${token}`)).toBe(401);
  });

  it('is rejected with 401 if it expired', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE], expiresIn: -60 });

    expect(await statusOf(`Bearer ${token}`)).toBe(401);
  });

  it('is rejected with 401 if another issuer issued it', async () => {
    const otherRealm = await keycloak.signToken({
      roles: [BACKEND_ROLE],
      issuer: `${keycloak.url}/realms/other`,
    });
    const otherHost = await keycloak.signToken({
      roles: [BACKEND_ROLE],
      issuer: `http://keycloak.example/realms/${REALM}`,
    });

    expect(await statusOf(`Bearer ${otherRealm}`)).toBe(401);
    expect(await statusOf(`Bearer ${otherHost}`)).toBe(401);
  });

  it('is rejected without the token in the error message', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE], forged: true });

    const error = await failure(verifier.verify(`Bearer ${token}`));

    expect(`${error.message} ${error.stack}`).not.toContain(token);
  });
});

describe("Keycloak's keys", () => {
  it('are unavailable (503) if Keycloak is not reachable', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE] });
    await keycloak.close();

    expect(await statusOf(`Bearer ${token}`)).toBe(503);
  });

  it('are unavailable (503) if Keycloak answers with an error or does not answer in time', async () => {
    const token = await keycloak.signToken({ roles: [BACKEND_ROLE] });
    for (const answer of [{ status: 500 }, 'hang' as const]) {
      const broken = await startFakeServer(() => answer);
      try {
        const brokenVerifier = createBackendTokenVerifier({ url: broken.url, realm: REALM, timeoutMs: 200 });

        expect((await failure(brokenVerifier.verify(`Bearer ${token}`))).status).toBe(503);
      } finally {
        await broken.close();
      }
    }
  });
});
