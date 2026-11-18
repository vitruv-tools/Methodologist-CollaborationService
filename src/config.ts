/** Settings of the collaboration server, read from environment variables. */
export interface Config {
  /** Port for HTTP (`GET /health`) and WebSocket connections. */
  port: number;
  /**
   * Base URL of the backend without a trailing slash. It is asked for a user's role in a project
   * and called with the service account.
   */
  backendUrl: string;
  /** Login of the collaboration server's own service account. */
  keycloak: KeycloakConfig;
}

/** How the collaboration server gets its service token from Keycloak. */
export interface KeycloakConfig {
  /** Base URL of Keycloak without a trailing slash, e.g. `http://localhost:7668`. */
  url: string;
  realm: string;
  clientId: string;
  /** Secret of the client. Never log it. */
  clientSecret: string;
}

export const DEFAULT_PORT = 1234;
export const DEFAULT_BACKEND_URL = 'http://localhost:9811';
export const DEFAULT_KEYCLOAK_REALM = 'methodologist';
export const DEFAULT_KEYCLOAK_CLIENT_ID = 'collaboration-service';

/** Variables without a default: the server doesn't start without them. */
const REQUIRED = ['KEYCLOAK_URL', 'KEYCLOAK_CLIENT_SECRET'] as const;

/**
 * Reads the configuration from the environment.
 *
 * @throws Error if a required variable is missing or a variable has an invalid value. The message
 *     names the variable, but never contains the client secret.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => !isSet(env[name]));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    port: parsePort(env.PORT),
    backendUrl: isSet(env.BACKEND_URL)
      ? parseHttpUrl('BACKEND_URL', env.BACKEND_URL)
      : DEFAULT_BACKEND_URL,
    keycloak: {
      url: parseHttpUrl('KEYCLOAK_URL', env.KEYCLOAK_URL ?? ''),
      realm: isSet(env.KEYCLOAK_REALM) ? env.KEYCLOAK_REALM.trim() : DEFAULT_KEYCLOAK_REALM,
      clientId: isSet(env.KEYCLOAK_CLIENT_ID)
        ? env.KEYCLOAK_CLIENT_ID.trim()
        : DEFAULT_KEYCLOAK_CLIENT_ID,
      clientSecret: (env.KEYCLOAK_CLIENT_SECRET ?? '').trim(),
    },
  };
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
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

function parseHttpUrl(name: string, value: string): string {
  const url = value.trim().replace(/\/+$/, '');
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error(`${name} must be an http or https URL, but is "${value}"`);
  }
  return url;
}
