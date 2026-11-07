import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses the default port when PORT is not set', () => {
    expect(loadConfig({})).toEqual({ port: DEFAULT_PORT });
  });

  it('uses the default port when PORT is empty', () => {
    expect(loadConfig({ PORT: ' ' })).toEqual({ port: DEFAULT_PORT });
  });

  it('reads PORT', () => {
    expect(loadConfig({ PORT: '8080' })).toEqual({ port: 8080 });
  });

  it.each(['abc', '-1', '65536', '12.5'])('rejects PORT=%s', (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow('PORT must be an integer between 0 and 65535');
  });
});
