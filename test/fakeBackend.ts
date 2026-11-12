import { bearerToken, startFakeServer, type FakeAnswer } from './fakeServer.js';

export type { FakeAnswer } from './fakeServer.js';

export interface FakeBackend {
  url: string;
  /** `Authorization` headers and paths of the requests received so far. */
  requests: { path: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

/** Answer of the real backend for a user with the given role. */
export function details(role: string): FakeAnswer {
  return { status: 200, body: { data: { id: 1, name: 'Project', role, metaModels: [] }, message: null } };
}

/**
 * Starts an HTTP server that stands in for the backend. It only knows
 * `GET /api/v1/vsums/{id}/details` and lets `answer` decide the response from token and project ID.
 */
export async function startFakeBackend(
  answer: (token: string | undefined, projectId: string) => FakeAnswer,
): Promise<FakeBackend> {
  const requests: FakeBackend['requests'] = [];
  const server = await startFakeServer((request) => {
    requests.push({ path: request.path, authorization: request.authorization });
    const match = /^\/api\/v1\/vsums\/(\d+)\/details$/.exec(request.path);
    if (request.method !== 'GET' || match === null) {
      return { status: 404 };
    }
    return answer(bearerToken(request), match[1]);
  });
  return { url: server.url, requests, close: server.close };
}
