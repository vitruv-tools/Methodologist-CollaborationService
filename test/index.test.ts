import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('starting the server', () => {
  it('stops with a message naming the missing variables', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Invalid configuration: Missing required environment variables: KEYCLOAK_URL, KEYCLOAK_CLIENT_SECRET',
    );
  });
});
