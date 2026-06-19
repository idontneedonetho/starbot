import type { Client, ThreadChannel } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';

const log = createLogger('title-sync');

export type ReportStatus = 'new' | 'waiting-for-dev' | 'waiting-for-user' | 'resolved' | 'closed';

export const STATUS_EMOJI: Record<ReportStatus, string> = {
  'new': '🟠',
  'waiting-for-dev': '🔴',
  'waiting-for-user': '🟣',
  'resolved': '🟢',
  'closed': '🔵',
};

const LEGACY_TYPE_EMOJIS = ['🐛', '💬', '✨'];
const KNOWN_TITLE_EMOJIS = [...Object.values(STATUS_EMOJI), ...LEGACY_TYPE_EMOJIS];

const FALLBACK_RETRY_MS = 10 * 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 10;
const TITLE_INDEX_KEY = 'pending';

// A thread waiting to have its title (and optionally its close) applied. `close`
// is persisted so a restart mid-deferral still finalizes the close in order.
interface PendingEntry {
  title: string;
  close?: boolean;
}

const titleStore = createStore<Record<string, PendingEntry>>('title-sync');

const syncing = new Set<string>();
let client: Client | null = null;

// Report close is owned by report-actions; it's injected here so the deferred
// worker (and restart recovery) can finalize a close without an import cycle.
let closeHandler: ((thread: ThreadChannel) => Promise<void>) | null = null;

export function setReportCloseHandler(fn: (thread: ThreadChannel) => Promise<void>): void {
  closeHandler = fn;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripLeadingEmoji(name: string): string {
  for (const e of KNOWN_TITLE_EMOJIS) {
    if (name.startsWith(e)) return name.slice(e.length);
  }
  return name;
}

const MAX_TITLE_LEN = 100;

// Derive the ticket id the same way report-service does: the trailing 7 digits of
// the thread's own snowflake.
function ticketIdFor(thread: ThreadChannel): string {
  return String(parseInt(thread.id.slice(-7), 10));
}

function computeStatusTitle(currentName: string, status: ReportStatus, ticketId: string): string {
  let base = stripLeadingEmoji(currentName);
  if (base.startsWith(' ')) base = base.slice(1);
  let title = `${STATUS_EMOJI[status]} ${base}`;
  // Reports are created without the (id) suffix to avoid spending a rename on the
  // strict 2-per-10-min title-edit bucket; fold it in here on the first status
  // change (which already rewrites the title). Skip if a suffix is already present.
  if (!/\(\d+\)\s*$/.test(title)) {
    const suffix = ` (${ticketId})`;
    if (title.length + suffix.length > MAX_TITLE_LEN) {
      title = title.slice(0, MAX_TITLE_LEN - suffix.length - 1).trimEnd() + '…';
    }
    title += suffix;
  }
  return title;
}

// A rate-limit rejection (discord.js RateLimitError) carries `timeToReset` and
// no Discord error `code`; that's the only failure we retry. Everything else
// (missing perms, invalid name, unknown channel, network) is non-retryable.
export function isRateLimit(err: unknown): boolean {
  return err != null && typeof err === 'object'
    && 'timeToReset' in err && typeof (err as { timeToReset?: unknown }).timeToReset === 'number';
}

function retryDelay(err: unknown): number {
  if (err != null && typeof err === 'object' && 'timeToReset' in err) {
    const t = (err as { timeToReset?: number }).timeToReset;
    if (typeof t === 'number' && t > 0) return t + 5_000;
  }
  return FALLBACK_RETRY_MS;
}

// Serialize read-modify-write on the shared index so concurrent status changes
// on different threads can't lose each other's entry (last-write-wins).
let indexChain: Promise<unknown> = Promise.resolve();

async function readIndex(): Promise<Record<string, PendingEntry>> {
  return (await titleStore.get(TITLE_INDEX_KEY)) ?? {};
}

function mutateIndex<T>(fn: (index: Record<string, PendingEntry>) => T): Promise<T> {
  const run = indexChain.then(async () => {
    const index = await readIndex();
    const result = fn(index);
    await titleStore.set(TITLE_INDEX_KEY, index);
    return result;
  });
  indexChain = run.then(() => undefined, () => undefined);
  return run;
}

function persistEntry(threadId: string, entry: PendingEntry): Promise<void> {
  return mutateIndex(index => { index[threadId] = entry; });
}

function clearEntry(threadId: string): Promise<void> {
  return mutateIndex(index => { delete index[threadId]; });
}

async function readEntry(threadId: string): Promise<PendingEntry | undefined> {
  return (await readIndex())[threadId];
}

async function runClose(thread: ThreadChannel): Promise<void> {
  if (!closeHandler) {
    log.error({ threadId: thread.id }, 'no close handler registered; cannot finalize close');
    return;
  }
  await closeHandler(thread);
}

/**
 * Apply the status emoji to a thread title, then optionally close it. The rename
 * and the close run in that order so a rename can never fire on an already-closed
 * (archived) thread. Returns true when the work was deferred to the background
 * worker because of a rate limit, so callers can tell the user it may take a
 * moment. Non-rate-limit failures are logged and abandoned.
 */
async function applyTitle(thread: ThreadChannel, status: ReportStatus, close: boolean): Promise<boolean> {
  const desired = computeStatusTitle(thread.name, status, ticketIdFor(thread));

  if (thread.name !== desired) {
    try {
      await thread.setName(desired);
    } catch (err) {
      if (isRateLimit(err)) {
        await persistEntry(thread.id, { title: desired, close });
        kickWorker(thread);
        return true;
      }
      log.warn({ err, threadId: thread.id }, 'title rename failed (non-rate-limit); leaving title unchanged');
    }
  }

  if (close) {
    try {
      await runClose(thread);
    } catch (err) {
      if (isRateLimit(err)) {
        await persistEntry(thread.id, { title: desired, close: true });
        kickWorker(thread);
        return true;
      }
      log.warn({ err, threadId: thread.id }, 'close failed (non-rate-limit); abandoning');
    }
  }

  await clearEntry(thread.id);
  return false;
}

// Fire-and-forget the worker without ever rejecting: an unhandled rejection
// crashes the whole bot (see process.on('unhandledRejection') in index.ts).
function kickWorker(thread: ThreadChannel): void {
  void syncWorker(thread).catch(err => log.warn({ err, threadId: thread.id }, 'title sync worker crashed'));
}

// Background worker that drains a thread's pending entry, retrying only on rate
// limits. On any other error it logs and gives up — once we're past the first
// attempt there's nothing actionable to surface.
async function syncWorker(thread: ThreadChannel): Promise<void> {
  if (syncing.has(thread.id)) return;
  syncing.add(thread.id);
  try {
    let rateLimitRetries = 0;
    for (;;) {
      const entry = await readEntry(thread.id);
      if (!entry) break;

      // If a pending close already landed (thread archived) but we crashed before
      // clearing it, treat it as done — re-editing would unarchive a closed report.
      if (entry.close && thread.archived) {
        await clearEntry(thread.id);
        break;
      }

      try {
        if (thread.name !== entry.title) await thread.setName(entry.title);
        if (entry.close) await runClose(thread);
      } catch (err) {
        if (isRateLimit(err)) {
          if (++rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            log.warn({ threadId: thread.id, rateLimitRetries }, 'title sync exhausted rate-limit retries; abandoning');
            await clearEntry(thread.id);
            break;
          }
          const wait = retryDelay(err);
          log.warn({ err, threadId: thread.id, waitMs: wait, rateLimitRetries }, 'title sync deferred (rate limit); will retry');
          await sleep(wait);
          continue;
        }
        log.warn({ err, threadId: thread.id }, 'deferred title sync failed (non-rate-limit); abandoning');
        await clearEntry(thread.id);
        break;
      }

      await clearEntry(thread.id);
      break;
    }
  } finally {
    syncing.delete(thread.id);
  }
}

/** Set the status emoji on a thread title (cosmetic; no close). */
export async function setThreadStatusEmoji(thread: ThreadChannel, status: ReportStatus): Promise<void> {
  await applyTitle(thread, status, false);
}

/**
 * Set the terminal status emoji and close the thread, in that order. Returns
 * true if the operation was deferred (rate limited) and will finish in the
 * background — the caller should tell the user it may take a moment.
 */
export function setThreadStatusAndClose(thread: ThreadChannel, status: ReportStatus): Promise<boolean> {
  return applyTitle(thread, status, true);
}

export function initTitleSync(c: Client): void {
  client = c;
  void recoverPending();
}

async function recoverPending(): Promise<void> {
  if (!client) return;
  const ids = Object.keys(await readIndex());
  if (ids.length === 0) return;
  log.info(`Recovering ${ids.length} pending title change(s)`);
  for (const threadId of ids) {
    try {
      const ch = await client.channels.fetch(threadId).catch(() => null);
      if (ch && ch.isThread()) {
        kickWorker(ch);
      } else {
        await clearEntry(threadId);
      }
    } catch (err) {
      log.warn({ err, threadId }, 'failed to recover pending title');
    }
  }
}
