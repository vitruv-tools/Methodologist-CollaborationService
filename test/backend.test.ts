import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError, createBackendClient, type BackendClient } from '../src/backend.js';
import { createServiceToken, ServiceTokenError } from '../src/serviceToken.js';
import { CLIENT_ID, CLIENT_SECRET, REALM, startFakeKeycloak, type FakeKeycloak } from './fakeKeycloak.js';
import {
  bearerToken,
  startFakeServer,
  type FakeAnswer,
  type FakeRequest,
  type FakeServer,
} from './fakeServer.js';

const PROJECT = { id: 12, name: 'Project', metaModels: [], metaModelsRelation: [], views: [] };

let keycloak: FakeKeycloak;
let backend: FakeServer;
/** Tokens the fake backend accepts. */
let accepted: Set<string>;
/** Answer of the fake backend to requests with an accepted token. */
let answer: (request: FakeRequest) => FakeAnswer;
let client: BackendClient;

beforeEach(async () => {
  keycloak = await startFakeKeycloak();
  accepted = new Set(['token-1']);
  answer = (request) =>
    request.method === 'GET'
      ? { status: 200, body: { data: PROJECT, message: null } }
      : { status: 200, body: { message: 'updated' } };
  backend = await startFakeServer((request) =>
    accepted.has(bearerToken(request) ?? '') ? answer(request) : { status: 401 },
  );
  client = createBackendClient({
    backendUrl: backend.url,
    serviceToken: createServiceToken({
      url: keycloak.url,
      realm: REALM,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 300,
    }),
    timeoutMs: 300,
  });
});

afterEach(async () => {
  await backend.close();
  await keycloak.close();
  vi.restoreAllMocks();
});

/** Resolves with the error `promise` is rejected with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('The promise was not rejected');
}

describe('internal endpoints', () => {
  it('loads a project with the service token', async () => {
    expect(await client.getProject('12')).toEqual(PROJECT);

    expect(backend.requests).toMatchObject([
      { method: 'GET', path: '/api/internal/v1/vsums/12/details', authorization: 'Bearer token-1' },
    ]);
  });

  it('writes changes back with the service token', async () => {
    const changes = { metaModelIds: [1, 2], layout: { nodes: {} } };

    await client.syncChanges('12', changes);

    expect(backend.requests).toMatchObject([
      {
        method: 'PUT',
        path: '/api/internal/v1/vsums/12/sync-changes',
        authorization: 'Bearer token-1',
        contentType: 'application/json',
      },
    ]);
    expect(JSON.parse(backend.requests[0].body)).toEqual(changes);
  });

  it('reuses the token for further requests', async () => {
    await client.getProject('12');
    await client.syncChanges('12', {});

    expect(keycloak.requests).toHaveLength(1);
    expect(backend.requests.map((request) => request.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-1',
    ]);
  });
});

describe('a rejected token', () => {
  it('is renewed, and the request is retried once', async () => {
    accepted = new Set(['token-2']);

    expect(await client.getProject('12')).toEqual(PROJECT);

    expect(keycloak.requests).toHaveLength(2);
    expect(backend.requests.map((request) => request.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('fails with 401 if the new token is rejected too, without retrying again', async () => {
    accepted = new Set();

    const error = await failure(client.syncChanges('12', {}));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).status).toBe(401);
    expect(backend.requests).toHaveLength(2);
    expect(keycloak.requests).toHaveLength(2);
  });
});

describe('failures', () => {
  it.each([400, 403, 404, 500])('passes status %i on without retrying', async (status) => {
    answer = () => ({ status });

    const error = await failure(client.getProject('12'));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).status).toBe(status);
    expect(backend.requests).toHaveLength(1);
  });

  it('fails without status if the backend does not answer in time', async () => {
    answer = () => 'hang';

    const error = await failure(client.syncChanges('12', {}));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).status).toBeUndefined();
    expect(error.message).toContain('The backend is not available');
  });

  it('fails if the backend answers without the project', async () => {
    answer = () => ({ status: 200, body: { data: null } });

    await expect(client.getProject('12')).rejects.toBeInstanceOf(BackendError);
  });

  it('fails without calling the backend if Keycloak gives no token', async () => {
    keycloak.answerNext({ status: 503 });

    await expect(client.getProject('12')).rejects.toBeInstanceOf(ServiceTokenError);
    expect(backend.requests).toHaveLength(0);
  });

  it('never logs or reports the secret or a token', async () => {
    const logged = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    accepted = new Set();

    const error = await failure(client.getProject('12'));

    for (const text of [error.message, String(error.stack)]) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toMatch(/token-\d/);
    }
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
