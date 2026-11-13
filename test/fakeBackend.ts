import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake backend answers to a request for a project's details. */
export type FakeAnswer =
  | { status: number; body?: unknown }
  /** Never answers, like a backend that hangs. */
  | 'hang';

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
  const server: Server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    requests.push({ path: request.url ?? '', authorization });
    const match = /^\/api\/v1\/vsums\/(\d+)\/details$/.exec(request.url ?? '');
    if (request.method !== 'GET' || match === null) {
      response.writeHead(404).end();
      return;
    }
    const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    const result = answer(token, match[1]);
    if (result === 'hang') {
      return;
    }
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
