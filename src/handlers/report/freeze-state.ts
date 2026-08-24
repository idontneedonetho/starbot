import { readConfigKey, writeConfigKey, deleteConfigKey } from '../../runtime-config.js';

const FREEZE_KEY = 'freeze';

export interface FreezeOverwrite {
  allow: string;
  deny: string;
}

export interface FreezeRecord {
  startedAt: number;
  expiresAt: number | null;
  message: string;
  initiatedBy: string;
  priorOverwrite: FreezeOverwrite | null;
  lockedThreadIds: string[];
  bannerMessageId: string | null;
  steps: { overwrite: boolean; buttons: boolean; locks: boolean; banner: boolean };
}

export const DEFAULT_FREEZE_MESSAGE = 'No new reports for developer rest. Come back later.';

export async function getFreeze(): Promise<FreezeRecord | null> {
  return (await readConfigKey<FreezeRecord>(FREEZE_KEY)) ?? null;
}

export async function isFrozen(): Promise<boolean> {
  return (await getFreeze()) !== null;
}

export async function saveFreeze(record: FreezeRecord): Promise<void> {
  await writeConfigKey(FREEZE_KEY, record);
}

export async function patchFreeze(patch: Partial<FreezeRecord>): Promise<FreezeRecord | null> {
  const current = await getFreeze();
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveFreeze(next);
  return next;
}

export async function clearFreeze(): Promise<void> {
  await deleteConfigKey(FREEZE_KEY);
}

// Freeze time never counts toward dormancy, but a thread also can't earn more
// than one full dormancy window of credit from a single freeze.
export function dormantBumpedAt(lastActivityAt: number, freeze: { startedAt: number; endedAt: number }, dormantMs: number): number {
  const bump = Math.min(freeze.endedAt - freeze.startedAt, dormantMs);
  return Math.min(Date.now(), lastActivityAt + bump);
}

// A freeze preserves the snooze's remaining time, capped at its original
// duration so a freeze can't inflate a snooze beyond what staff asked for.
export function snoozeAdjustedWake(wakeAt: number, scheduledAt: number | undefined, freeze: { startedAt: number; endedAt: number }): number {
  const duration = scheduledAt !== undefined ? wakeAt - scheduledAt : Math.max(0, wakeAt - freeze.startedAt);
  const bump = Math.min(freeze.endedAt - freeze.startedAt, Math.max(0, duration));
  return wakeAt + bump;
}
