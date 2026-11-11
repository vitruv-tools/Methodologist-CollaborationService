import { describe, expect, it } from 'vitest';
import { isAllowedForViewer } from '../src/readOnly.js';

describe('isAllowedForViewer', () => {
  it.each([
    ['sync step 1', [0, 0, 1, 0], true],
    ['sync step 2', [0, 1, 2, 0, 0], false],
    ['an update', [0, 2, 2, 0, 0], false],
    ['an unknown sync step', [0, 3], false],
    ['a sync message without a step', [0], false],
    ['awareness', [1, 1, 0], true],
    ['an auth message', [2, 0], false],
    ['an awareness query', [3], false],
    ['an empty message', [], false],
  ])('%s: %j -> %s', (_name, bytes, allowed) => {
    expect(isAllowedForViewer(Uint8Array.from(bytes))).toBe(allowed);
  });
});
