import type { Client, ThreadChannel } from 'discord.js';
import { EmbedBuilder, Events, GuildMember, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { Discord, On, ArgsOf, Slash, SlashOption, Guild } from 'discordx';
import { ApplicationCommandOptionType } from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { COLORS } from '../../util.js';
import { StoredReport } from './report-store.js';
import { getForum } from './route-tracker.js';
import { swapForumTags } from './report-service.js';
import { scheduleClose, cancelScheduledClose, getScheduledClose, nextCloseAt, closingNoticeField } from './close-scheduler.js';
import { computeStatusTitle } from './title-sync.js';
import { getScheduledSnooze } from './snooze-scheduler.js';

const log = createLogger('dormant-scheduler');

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Caps notices + rename-sublimit load; the rest wait for the next sweep.
const MAX_CLOSES_PER_SWEEP = 10;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export function initDormantScheduler(client: Client): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweep(client); }, SWEEP_INTERVAL_MS);
  setTimeout(() => { void sweep(client); }, 60_000).unref();
}

export async function sweep(client: Client): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const config = loadConfig();
    const guild = client.guilds.cache.get(config.guildId) ?? await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) return;
    const forum = await getForum(guild, config.forumChannelId);
    if (!forum) return;

    const dormantAfterMs = config.dormantCloseDays * 24 * 60 * 60 * 1000;
    const reports = await StoredReport.listAll();
    let closed = 0;
    let reconciled = 0;
    let deferred = 0;

    // Most dormant first so the per-sweep cap spends itself on the stalest.
    // Only waiting-for-user reports: the ball is in the user's court, so a long
    // silence means they've lost interest. Dev-waiting reports are never auto-closed.
    const active = reports
      .filter(r => r.category === 'Needs your Attention')
      .sort((a, b) => a.data.lastActivityAt - b.data.lastActivityAt);

    for (const report of active) {
      if (closed >= MAX_CLOSES_PER_SWEEP) {
        deferred += active.length - active.indexOf(report);
        break;
      }
      const thread = await client.channels.fetch(report.threadId).catch(() => null);
      if (!thread?.isThread()) continue;
      const snoozed = report.category === 'Snoozed' || await getScheduledSnooze(thread.id).catch(() => undefined);
      if (snoozed) continue;
      const dormant = await isDormant(thread, report.data.lastActivityAt, dormantAfterMs);
      if (!dormant) continue;
      const did = await beginDormantClose(thread, config.dormantCloseDays);
      if (did) closed++;
    }

    for (const report of reports) {
      if (report.isActive) continue;
      const thread = await client.channels.fetch(report.threadId).catch(() => null);
      if (!thread?.isThread()) continue;
      if (await hasDormantCloseNotice(thread)) continue;
      const fixed = await reconcileClosedTags(thread, forum);
      if (fixed) reconciled++;
    }

    if (closed > 0 || reconciled > 0 || deferred > 0) {
      log.info({ closed, reconciled, deferred, total: reports.length }, 'Dormant sweep complete');
    }
  } catch (err) {
    log.warn({ err }, 'Dormant sweep failed');
  } finally {
    sweeping = false;
  }
}

async function isDormant(thread: ThreadChannel, storedActivity: number, thresholdMs: number): Promise<boolean> {
  let last = storedActivity;
  try {
    const messages = await thread.messages.fetch({ limit: 1 });
    const newest = messages.last();
    if (newest) last = Math.max(last, newest.createdTimestamp ?? 0);
  } catch (err) {
    // Stored activity can be stale (backfill only knew createdTimestamp).
    log.warn({ err, threadId: thread.id }, 'Failed to read last message for dormancy check; skipping');
    return false;
  }
  if (last > 0 && Date.now() - last < thresholdMs) {
    // Write the fresher activity back so the next sweep can skip the fetch.
    if (last > storedActivity) await StoredReport.update(thread.id, { lastActivityAt: last });
    return false;
  }
  return true;
}

async function beginDormantClose(thread: ThreadChannel, dormantDays: number): Promise<boolean> {
  const closeAt = nextCloseAt();
  const notice = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle('💤 Dormant Report')
    .setDescription(`No activity for ${dormantDays} days — this report will close automatically. Reply here before it closes to keep it open.`)
    .addFields(closingNoticeField(closeAt))
    .setTimestamp();
  const noticeMsg = await thread.send({ embeds: [notice] }).catch(err => {
    log.warn({ err, threadId: thread.id }, 'Failed to post dormant-close notice');
    return null;
  });
  const scheduled = await scheduleClose(thread, 'closed', closeAt, noticeMsg?.id ?? '', 'dormant');
  if (!scheduled) {
    await noticeMsg?.delete().catch(() => {});
    return false;
  }
  log.info({ threadId: thread.id }, 'Scheduled dormant close');
  return true;
}

// Only dormant-origin closes are cancelled; staff/user closes stay authoritative.
async function cancelDormantCloseOnActivity(thread: ThreadChannel): Promise<void> {
  const entry = await getScheduledClose(thread.id);
  if (!entry || entry.origin !== 'dormant') return;
  const claimed = await cancelScheduledClose(thread.id);
  if (!claimed) return;
  await StoredReport.update(thread.id, { lastActivityAt: Date.now() });
  if (!claimed.noticeMessageId) return;
  const msg = await thread.messages.fetch(claimed.noticeMessageId).catch(() => null);
  const embed = msg?.embeds[0];
  if (!msg || !embed) return;
  const fields = (embed.fields ?? []).filter(f => !f.value.startsWith('⏳ Closing '));
  await msg.edit({
    embeds: [EmbedBuilder.from(embed).setColor(COLORS.green).setTitle('🔓 Close Cancelled').setFields(fields)],
  }).catch(err => log.warn({ err, threadId: thread.id }, 'Failed to finalize cancelled dormant-close notice'));
  log.info({ threadId: thread.id }, 'Dormant close cancelled by new activity');
}

// Fixes tag drift on already-closed threads without touching lock state.
async function reconcileClosedTags(thread: ThreadChannel, forum: import('discord.js').ForumChannel): Promise<boolean> {
  const tagNameById = new Map(forum.availableTags.map(t => [t.id, t.name.toUpperCase()]));
  const live = (thread.appliedTags as string[]).map(id => tagNameById.get(id) ?? '');
  const hasClosed = live.includes('CLOSED') || live.includes('FIXED');
  const needsFix =
    !hasClosed ||
    live.includes('OPEN') || live.includes('WAITING FOR DEV') || live.includes('WAITING FOR USER');
  if (!needsFix) return false;
  // Discord rejects applied_tags edits on archived threads (50083), so unarchive
  // for the swap and restore the archived state after.
  const wasArchived = thread.archived;
  if (wasArchived) await thread.setArchived(false).catch(() => {});
  await swapForumTags(thread, forum, { remove: ['OPEN', 'WAITING FOR DEV', 'WAITING FOR USER'], add: ['CLOSED'] });
  if (wasArchived) await thread.setArchived(true).catch(() => {});
  await StoredReport.syncFromThread(thread);
  return true;
}

const DORMANT_NOTICE_TITLE = '💤 Dormant Report';

async function hasDormantCloseNotice(thread: ThreadChannel): Promise<boolean> {
  const botId = thread.client.user?.id;
  const messages = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return false;
  return messages.some(m => (!botId || m.author.id === botId) &&
    m.embeds[0]?.title === DORMANT_NOTICE_TITLE);
}

/**
 * Recovery for threads closed by the dormant sweep before it was gated to
 * waiting-for-user reports. Identifies them by their dormant notice embed and
 * reopens each as WAITING FOR DEV. Exact prior status isn't recoverable, so
 * staff should spot-check afterwards.
 */
export async function recoverDormantClosures(
  client: import('discord.js').Client,
  dryRun: boolean,
): Promise<{ found: number; reopened: number; failed: number }> {
  const config = loadConfig();
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return { found: 0, reopened: 0, failed: 0 };
  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) return { found: 0, reopened: 0, failed: 0 };

  const result = { found: 0, reopened: 0, failed: 0 };
  const reports = await StoredReport.listAll();
  for (const report of reports) {
    const thread = await client.channels.fetch(report.threadId).catch(() => null);
    if (!thread?.isThread()) continue;
    if (thread.parentId !== forum.id) continue;
    const tagNameById = new Map(forum.availableTags.map(t => [t.id, t.name.toUpperCase()]));
    const live = (thread.appliedTags as string[]).map(id => tagNameById.get(id) ?? '');
    const closed = live.includes('CLOSED');
    if (!closed || !(thread.archived || thread.locked)) continue;
    if (!(await hasDormantCloseNotice(thread))) continue;
    result.found++;
    if (dryRun) continue;
    try {
      if (thread.archived) await thread.setArchived(false);
      if (thread.locked) await thread.setLocked(false);
      await swapForumTags(thread, forum, { remove: ['CLOSED'], add: ['OPEN', 'WAITING FOR DEV'] });
      const desired = computeStatusTitle(thread.name, 'waiting-for-dev', report.data.ticketId);
      if (thread.name !== desired) await thread.setName(desired).catch(err =>
        log.warn({ err, threadId: thread.id }, 'Recovery rename failed (rename sublimit?); tags still restored'));
      await StoredReport.syncFromThread(thread);
      result.reopened++;
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'Dormant closure recovery failed');
      result.failed++;
    }
  }
  return result;
}

@Discord()
@Guild(loadConfig().guildId)
export class DormantRecoveryCommands {
  @Slash({
    description: 'Reopen threads auto-closed by the dormant sweep (before it was gated to waiting-for-user)',
    name: 'recover-dormant-closes',
    defaultMemberPermissions: PermissionFlagsBits.ManageThreads,
  })
  async recover(
    @SlashOption({
      name: 'dry_run',
      description: 'Only list what would be reopened (default true)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    dryRunOpt: boolean | undefined,
    interaction: import('discord.js').CommandInteraction,
  ) {
    if (!(interaction.member instanceof GuildMember) ||
        !interaction.member.roles.cache.has(loadConfig().staffRole)) {
      await interaction.reply({ content: 'Only staff can run recovery.', flags: MessageFlags.Ephemeral });
      return;
    }
    const client = interaction.client;
    const dryRun = dryRunOpt !== false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await recoverDormantClosures(client, dryRun);
    await interaction.editReply(dryRun
      ? `Dry run: found **${result.found}** dormant-closed thread(s) that would be reopened as WAITING FOR DEV.`
      : `Recovery complete: found **${result.found}**, reopened **${result.reopened}**, failed **${result.failed}**. Threads are back to WAITING FOR DEV — spot-check statuses that were WAITING FOR USER before.`);
  }
}

@Discord()
export class DormantCloseCancelHandler {
  @On({ event: Events.MessageCreate })
  async cancelOnReply([message]: ArgsOf<Events.MessageCreate>) {
    if (message.author.bot) return;
    const channel = message.channel;
    if (!channel.isThread()) return;
    if (!channel.parentId) return;
    if (channel.parentId !== loadConfig().forumChannelId) return;
    await cancelDormantCloseOnActivity(channel).catch(err =>
      log.warn({ err, threadId: channel.id }, 'Dormant-close cancel failed'));
  }
}
