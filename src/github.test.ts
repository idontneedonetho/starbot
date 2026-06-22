import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ loadConfig: () => ({ mainRepo: 'owner/repo' }) }));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { fetchCommitChoices } from './github.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchCommitChoices', () => {
  // Regression: branches share history, so the same commit appears on both. Option
  // values must be unique or Discord rejects the whole select menu (50035).
  it('dedupes commits shared across branches', async () => {
    const commit = (sha: string, date: string) => ({
      sha, commit: { message: 'build', committer: { date } },
    });
    const shared = commit('5'.repeat(40), '2026-06-20T05:00:00Z');
    const star = commit('a'.repeat(40), '2026-06-20T04:00:00Z');
    const dom = commit('d'.repeat(40), '2026-06-20T06:00:00Z');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const branch = new URL(url).searchParams.get('sha');
      return { ok: true, json: async () => (branch === 'Dom' ? [shared, dom] : [shared, star]) };
    }));

    const values = (await fetchCommitChoices()).map(c => c.sha);

    expect(values.length).toBe(new Set(values).size);
    expect(values.filter(v => v === shared.sha)).toHaveLength(1);
  });
});
