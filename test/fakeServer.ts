import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a fake server answers to a request. */
export type FakeAnswer =
  | { status: number; body?: unknown }
  /** Never answers, like a server that hangs. */
  | 'hang';

/** A request as a fake server received it. */
export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  /** The request body as text, empty if there is none. */
  body: string;
}

export interface FakeServer {
  url: string;
  /** The requests received so far. */
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** Returns the token of a `Bearer` authorization header. */
export function bearerToken(request: FakeRequest): string | undefined {
  return /^Bearer (.+)$/.exec(request.authorization ?? '')?.[1];
}

/** Starts an HTTP server on a free port that lets `answer` decide every response. */
export async function startFakeServer(
  answer: (request: FakeRequest) => FakeAnswer,
): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: FakeRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        authorization: incoming.headers.authorization,
        contentType: incoming.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      const result = answer(request);
      if (result === 'hang') {
        return;
      }
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}));
    });
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
