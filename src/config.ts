/** Settings of the collaboration server, read from environment variables. */
export interface Config {
  /** Port for HTTP (`GET /health`) and WebSocket connections. */
  port: number;
}

export const DEFAULT_PORT = 1234;

/**
 * Reads the configuration from the environment.
 *
 * @throws Error if a variable has an invalid value
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { port: parsePort(env.PORT) };
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
