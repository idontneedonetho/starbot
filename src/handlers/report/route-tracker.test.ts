import { describe, expect, it, vi } from 'vitest';

// route-tracker transitively loads the sqlite store + pino logger at import; stub both.
vi.mock('../../store.js', () => ({
  createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {} }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { trackerThreadName } from './route-tracker.js';

describe('trackerThreadName', () => {
  // Regression: trackers were keyed on the report title alone, so two reports with the
  // same title shared one tracker and the second's route landed on the first's thread.
  it('keys per report so same-titled reports get distinct trackers', () => {
    expect(trackerThreadName('🟠 Bug Report - Map Glitch', '123')).toBe('Bug Report - Map Glitch (123)');
    expect(trackerThreadName('🟠 Bug Report - Map Glitch', '456')).toBe('Bug Report - Map Glitch (456)');
  });

  it('strips an existing ticket suffix before re-appending (idempotent across the report lifecycle)', () => {
    expect(trackerThreadName('🔴 Bug Report - Map Glitch (123)', '123')).toBe('Bug Report - Map Glitch (123)');
  });

  it('falls back to the bare title when no ticket id is available', () => {
    expect(trackerThreadName('🟠 Bug Report - Map Glitch', '')).toBe('Bug Report - Map Glitch');
  });
});
