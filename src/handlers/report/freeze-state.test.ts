import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => true),
    delete: vi.fn(async () => true),
  }),
}));

import { dormantBumpedAt, snoozeAdjustedWake } from './freeze-state.js';

const DAY = 24 * 60 * 60 * 1000;
const DORMANT_MS = 14 * DAY;

describe('dormantBumpedAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T00:00:00Z').getTime());
  });

  it('shifts activity by the freeze duration', () => {
    const freeze = { startedAt: Date.now() - 2 * DAY, endedAt: Date.now() };
    expect(dormantBumpedAt(Date.now() - 10 * DAY, freeze, DORMANT_MS)).toBe(Date.now() - 8 * DAY);
  });

  it('caps the bump at one dormancy window', () => {
    const freeze = { startedAt: Date.now() - 30 * DAY, endedAt: Date.now() };
    expect(dormantBumpedAt(Date.now() - 20 * DAY, freeze, DORMANT_MS)).toBe(Date.now() - 6 * DAY);
  });

  it('never bumps activity into the future', () => {
    const freeze = { startedAt: Date.now() - DAY, endedAt: Date.now() };
    expect(dormantBumpedAt(Date.now() - DAY / 2, freeze, DORMANT_MS)).toBeLessThanOrEqual(Date.now());
  });
});

describe('snoozeAdjustedWake', () => {
  it('preserves remaining snooze time across the freeze', () => {
    const scheduledAt = 0;
    const wakeAt = 5 * DAY;
    const freeze = { startedAt: 3 * DAY, endedAt: 6 * DAY };
    // 2d remained at freeze start; 3d freeze -> wake 2d after thaw.
    expect(snoozeAdjustedWake(wakeAt, scheduledAt, freeze)).toBe(8 * DAY);
  });

  it('caps the extension at the original snooze duration', () => {
    const scheduledAt = 0;
    const wakeAt = 2 * DAY; // 1d snooze
    const freeze = { startedAt: 1 * DAY, endedAt: 10 * DAY };
    expect(snoozeAdjustedWake(wakeAt, scheduledAt, freeze)).toBe(4 * DAY);
  });

  it('falls back to remaining time when scheduledAt is unknown', () => {
    const wakeAt = 5 * DAY;
    const freeze = { startedAt: 3 * DAY, endedAt: 6 * DAY };
    expect(snoozeAdjustedWake(wakeAt, undefined, freeze)).toBe(7 * DAY);
  });
});
