import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_KEYCLOAK_CLIENT_ID,
  DEFAULT_KEYCLOAK_REALM,
  DEFAULT_PORT,
  loadConfig,
} from '../src/config.js';

/** The variables without a default. */
const REQUIRED = { KEYCLOAK_URL: 'http://localhost:7668', KEYCLOAK_CLIENT_SECRET: 'secret' };

/** Loads the configuration from the required variables plus `env`. */
function load(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ ...REQUIRED, ...env });
}

describe('loadConfig', () => {
  it('uses the default port when PORT is not set', () => {
    expect(load().port).toBe(DEFAULT_PORT);
  });

  it('uses the default port when PORT is empty', () => {
    expect(load({ PORT: ' ' }).port).toBe(DEFAULT_PORT);
  });

  it('reads PORT', () => {
    expect(load({ PORT: '8080' }).port).toBe(8080);
  });

  it.each(['abc', '-1', '65536', '12.5'])('rejects PORT=%s', (value) => {
    expect(() => load({ PORT: value })).toThrow('PORT must be an integer between 0 and 65535');
  });

  it('uses the default backend URL when BACKEND_URL is not set or empty', () => {
    expect(load().backendUrl).toBe(DEFAULT_BACKEND_URL);
    expect(load({ BACKEND_URL: ' ' }).backendUrl).toBe(DEFAULT_BACKEND_URL);
  });

  it('reads BACKEND_URL without trailing slashes', () => {
    expect(load({ BACKEND_URL: 'https://backend.example/' }).backendUrl).toBe(
      'https://backend.example',
    );
  });

  it.each(['backend', 'ftp://backend.example', 'localhost:9811'])(
    'rejects BACKEND_URL=%s',
    (value) => {
      expect(() => load({ BACKEND_URL: value })).toThrow(
        'BACKEND_URL must be an http or https URL',
      );
    },
  );
});

describe('loadConfig for Keycloak', () => {
  it('names all missing required variables', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variables: KEYCLOAK_URL, KEYCLOAK_CLIENT_SECRET',
    );
  });

  it('treats an empty variable as missing', () => {
    expect(() => load({ KEYCLOAK_CLIENT_SECRET: ' ' })).toThrow(
      'Missing required environment variables: KEYCLOAK_CLIENT_SECRET',
    );
  });

  it('uses the default realm and client ID', () => {
    expect(load().keycloak).toEqual({
      url: 'http://localhost:7668',
      realm: DEFAULT_KEYCLOAK_REALM,
      clientId: DEFAULT_KEYCLOAK_CLIENT_ID,
      clientSecret: 'secret',
    });
  });

  it('reads all Keycloak variables', () => {
    const config = load({
      KEYCLOAK_URL: 'https://keycloak.example/',
      KEYCLOAK_REALM: 'other-realm',
      KEYCLOAK_CLIENT_ID: 'other-client',
      KEYCLOAK_CLIENT_SECRET: ' other-secret ',
    });

    expect(config.keycloak).toEqual({
      url: 'https://keycloak.example',
      realm: 'other-realm',
      clientId: 'other-client',
      clientSecret: 'other-secret',
    });
  });

  it('rejects an invalid KEYCLOAK_URL without naming the secret', () => {
    expect(() => load({ KEYCLOAK_URL: 'keycloak' })).toThrow(
      new Error('KEYCLOAK_URL must be an http or https URL, but is "keycloak"'),
    );
  });
});
