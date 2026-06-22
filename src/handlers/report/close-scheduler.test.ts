import { describe, expect, it, vi } from 'vitest';

// close-scheduler imports title-sync (→ sqlite store + pino logger); stub both.
vi.mock('../../store.js', () => ({
  createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {} }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { closingNoticeField, nextCloseAt, CLOSE_DELAY_MS } from './close-scheduler.js';

describe('closingNoticeField', () => {
  it('renders a relative Discord timestamp in seconds for the close time', () => {
    expect(closingNoticeField(1782112020000).value).toBe('⏳ Closing <t:1782112020:R>');
  });
});

describe('nextCloseAt', () => {
  it('is CLOSE_DELAY_MS in the future', () => {
    const remaining = nextCloseAt() - Date.now();
    expect(remaining).toBeGreaterThan(CLOSE_DELAY_MS - 1000);
    expect(remaining).toBeLessThanOrEqual(CLOSE_DELAY_MS);
  });
});
