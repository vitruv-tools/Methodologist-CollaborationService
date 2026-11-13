import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKEND_URL, DEFAULT_PORT, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses the default port when PORT is not set', () => {
    expect(loadConfig({}).port).toBe(DEFAULT_PORT);
  });

  it('uses the default port when PORT is empty', () => {
    expect(loadConfig({ PORT: ' ' }).port).toBe(DEFAULT_PORT);
  });

  it('reads PORT', () => {
    expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
  });

  it.each(['abc', '-1', '65536', '12.5'])('rejects PORT=%s', (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow('PORT must be an integer between 0 and 65535');
  });

  it('uses the default backend URL when BACKEND_URL is not set or empty', () => {
    expect(loadConfig({}).backendUrl).toBe(DEFAULT_BACKEND_URL);
    expect(loadConfig({ BACKEND_URL: ' ' }).backendUrl).toBe(DEFAULT_BACKEND_URL);
  });

  it('reads BACKEND_URL without trailing slashes', () => {
    expect(loadConfig({ BACKEND_URL: 'https://backend.example/' }).backendUrl).toBe(
      'https://backend.example',
    );
  });

  it.each(['backend', 'ftp://backend.example', 'localhost:9811'])(
    'rejects BACKEND_URL=%s',
    (value) => {
      expect(() => loadConfig({ BACKEND_URL: value })).toThrow(
        'BACKEND_URL must be an http or https URL',
      );
    },
  );
});
