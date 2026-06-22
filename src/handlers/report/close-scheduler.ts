import type { Client, ThreadChannel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';
import { tryStatusClose, type ReportStatus } from './title-sync.js';

const log = createLogger('close-scheduler');

export const CLOSE_DELAY_MS = 5 * 60 * 1000;

const CLOSING_PREFIX = '⏳ Closing ';

interface ScheduledClose {
  status: ReportStatus;
  closeAt: number;
  noticeMessageId: string;
}

const store = createStore<Record<string, ScheduledClose>>('close-schedule');
const INDEX_KEY = 'pending';
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let client: Client | null = null;

async function readIndex(): Promise<Record<string, ScheduledClose>> {
  return (await store.get(INDEX_KEY)) ?? {};
}

let chain: Promise<unknown> = Promise.resolve();
function mutate(fn: (index: Record<string, ScheduledClose>) => void): Promise<void> {
  const run = chain.then(async () => {
    const index = await readIndex();
    fn(index);
    await store.set(INDEX_KEY, index);
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export function nextCloseAt(): number {
  return Date.now() + CLOSE_DELAY_MS;
}

export function closingNoticeField(closeAt: number): { name: string; value: string } {
  return { name: '​', value: `${CLOSING_PREFIX}<t:${Math.floor(closeAt / 1000)}:R>` };
}

export async function getScheduledClose(threadId: string): Promise<ScheduledClose | undefined> {
  return (await readIndex())[threadId];
}

export async function scheduleClose(
  thread: ThreadChannel,
  status: ReportStatus,
  closeAt: number,
  noticeMessageId: string,
): Promise<void> {
  await mutate(index => { index[thread.id] = { status, closeAt, noticeMessageId }; });
  armTimer(thread.id, closeAt);
}

function armTimer(threadId: string, closeAt: number): void {
  const existing = timers.get(threadId);
  if (existing) clearTimeout(existing);
  timers.set(threadId, setTimeout(() => void fire(threadId), Math.max(0, closeAt - Date.now())));
}

async function fire(threadId: string): Promise<void> {
  timers.delete(threadId);
  const entry = (await readIndex())[threadId];
  if (!entry || !client) return;
  const ch = await client.channels.fetch(threadId).catch(() => null);
  if (!ch?.isThread()) {
    await mutate(index => { delete index[threadId]; });
    return;
  }
  // Strip the countdown before closing - an archived thread can't be edited afterward.
  await stripClosingNotice(ch, entry.noticeMessageId);
  const result = await tryStatusClose(ch, entry.status);
  if (!result.done) {
    const closeAt = Date.now() + result.retryMs;
    await mutate(index => { if (index[threadId]) index[threadId].closeAt = closeAt; });
    await stripClosingNotice(ch, entry.noticeMessageId, closeAt);
    armTimer(threadId, closeAt);
    return;
  }
  await mutate(index => { delete index[threadId]; });
}

async function stripClosingNotice(thread: ThreadChannel, messageId: string, replaceWith?: number): Promise<void> {
  if (!messageId) return;
  const msg = await thread.messages.fetch(messageId).catch(() => null);
  const embed = msg?.embeds[0];
  if (!msg || !embed) return;
  const fields = (embed.fields ?? []).filter(f => !f.value.startsWith(CLOSING_PREFIX));
  if (replaceWith !== undefined) fields.push(closingNoticeField(replaceWith));
  await msg.edit({ embeds: [EmbedBuilder.from(embed).setFields(fields)] }).catch(err => log.warn({ err }, 'Failed to edit closing notice'));
}

export function initCloseScheduler(c: Client): void {
  client = c;
  void recover();
}

async function recover(): Promise<void> {
  const index = await readIndex();
  const ids = Object.keys(index);
  if (ids.length === 0) return;
  log.info(`Recovering ${ids.length} scheduled close(s)`);
  for (const id of ids) armTimer(id, index[id].closeAt);
}
