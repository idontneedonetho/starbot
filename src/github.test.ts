import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep the unit hermetic: no real GitHub calls, no .env required.
vi.mock('./config.js', () => ({ loadConfig: () => ({ mainRepo: 'owner/repo' }) }));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { compareCommits } from './github.js';

afterEach(() => vi.unstubAllGlobals());

// Distinct SHAs per case so the module-level compare cache never returns a prior result.
function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}
function ok(status: string) {
  return async () => ({ ok: true, json: async () => ({ status }) });
}

describe('compareCommits verdict mapping', () => {
  it('ahead -> ok', async () => {
    stubFetch(ok('ahead'));
    expect(await compareCommits('a1', 'b1')).toBe('ok');
  });

  it('identical -> ok', async () => {
    stubFetch(ok('identical'));
    expect(await compareCommits('a2', 'b2')).toBe('ok');
  });

  it('behind -> older', async () => {
    stubFetch(ok('behind'));
    expect(await compareCommits('a3', 'b3')).toBe('older');
  });

  // BUG 2 regression: diverged must be its own verdict, not folded into 'unknown'.
  it('diverged -> diverged', async () => {
    stubFetch(ok('diverged'));
    expect(await compareCommits('a4', 'b4')).toBe('diverged');
  });

  it('non-OK response (404) -> unknown', async () => {
    stubFetch(async () => ({ ok: false, status: 404 }));
    expect(await compareCommits('a5', 'b5')).toBe('unknown');
  });

  it('network error -> unknown', async () => {
    stubFetch(async () => { throw new Error('network down'); });
    expect(await compareCommits('a6', 'b6')).toBe('unknown');
  });
});
