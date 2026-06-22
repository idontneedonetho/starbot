import { describe, expect, it, vi } from 'vitest';

// title-sync opens the sqlite store + pino logger at import; stub both.
vi.mock('../../store.js', () => ({
  createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {} }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { computeStatusTitle, isRateLimit, retryDelay } from './title-sync.js';

const FALLBACK_RETRY_MS = 10 * 60 * 1000;

describe('retryDelay', () => {
  it('prefers retryAfter/sublimitTimeout over the shorter timeToReset', () => {
    expect(retryDelay({ timeToReset: 15_100, retryAfter: 323_050, sublimitTimeout: 323_050 }))
      .toBe(323_050 + 1_000);
  });

  it('falls back to timeToReset when no sublimit wait is present', () => {
    expect(retryDelay({ timeToReset: 15_100 })).toBe(15_100 + 1_000);
  });

  it('uses the fallback when no rate-limit timing is present', () => {
    expect(retryDelay({})).toBe(FALLBACK_RETRY_MS);
    expect(retryDelay(new Error('boom'))).toBe(FALLBACK_RETRY_MS);
  });
});

describe('isRateLimit', () => {
  it('is true only for objects carrying a numeric timeToReset', () => {
    expect(isRateLimit({ timeToReset: 5 })).toBe(true);
    expect(isRateLimit({})).toBe(false);
    expect(isRateLimit(new Error('nope'))).toBe(false);
    expect(isRateLimit(null)).toBe(false);
  });
});

describe('computeStatusTitle', () => {
  it('swaps the status emoji and adds the ticket id when absent', () => {
    expect(computeStatusTitle('🟠 Bug - Map Glitch', 'waiting-for-dev', '123'))
      .toBe('🔴 Bug - Map Glitch (123)');
  });

  it('does not duplicate the ticket id when already present', () => {
    expect(computeStatusTitle('🔴 Bug - Map Glitch (123)', 'waiting-for-user', '123'))
      .toBe('🟣 Bug - Map Glitch (123)');
  });

  it('truncates so the title stays within Discord\'s 100-char limit', () => {
    const long = '🟠 Bug - ' + 'x'.repeat(120);
    const out = computeStatusTitle(long, 'closed', '999');
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(' (999)')).toBe(true);
    expect(out.startsWith('🔵 ')).toBe(true);
  });
});
