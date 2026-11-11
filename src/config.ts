/** Settings of the collaboration server, read from environment variables. */
export interface Config {
  /** Port for HTTP (`GET /health`) and WebSocket connections. */
  port: number;
  /** Base URL of the backend without a trailing slash. It is asked for a user's role in a project. */
  backendUrl: string;
}

export const DEFAULT_PORT = 1234;
export const DEFAULT_BACKEND_URL = 'http://localhost:9811';

/**
 * Reads the configuration from the environment.
 *
 * @throws Error if a variable has an invalid value
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { port: parsePort(env.PORT), backendUrl: parseBackendUrl(env.BACKEND_URL) };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, but is "${value}"`);
  }
  return port;
}

function parseBackendUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_BACKEND_URL;
  }
  const backendUrl = value.trim().replace(/\/+$/, '');
  if (!URL.canParse(backendUrl) || !/^https?:$/.test(new URL(backendUrl).protocol)) {
    throw new Error(`BACKEND_URL must be an http or https URL, but is "${value}"`);
  }
  return backendUrl;
}
