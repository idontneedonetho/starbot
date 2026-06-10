import type { Guild, ThreadChannel } from 'discord.js';
import {
  GuildMember,
  MessageFlags,
  ForumChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { LRUCache } from 'lru-cache';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { COLORS, formatGitBranch, formatGitCommit } from '../../util.js';
import {
  parseRouteComponents,
  fetchRouteMetadata,
  secondsToSegment,
  segmentToSeconds,
  validateRoute,
  type ExtractedRoute,
  type RouteComponents,
} from '../../comma.js';

const log = createLogger('route-tracker');

export const TRACKER_FIELD_PREFIX = '[Mods Route Tracker \u2192]';
export const ORIGINAL_POST_PREFIX = '[Original Post \u2192]';

const STATUS_EMOJI = {
  public: '\uD83C\uDF0E',
  private: '\u26AB',
  logs: '\uD83D\uDCDC',
  noLogs: '\u26A0\uFE0F',
  refresh: '\uD83D\uDD04',
} as const;

const STATUS_LEGEND =
  `${STATUS_EMOJI.public} = public | ${STATUS_EMOJI.private} = private | ` +
  `${STATUS_EMOJI.logs} = logs | ${STATUS_EMOJI.noLogs} = no/partial logs`;

const STATUS_PREFIX_RE = new RegExp(
  `^(?:${STATUS_EMOJI.public} (?:${STATUS_EMOJI.logs}|${STATUS_EMOJI.noLogs}) |${STATUS_EMOJI.private} )`,
  'u',
);

function routeStatusEmoji(r: ExtractedRoute): string {
  if (r.public === undefined) return '';
  if (!r.public) return `${STATUS_EMOJI.private} `;
  return `${STATUS_EMOJI.public} ${r.rlogsAvailable ? STATUS_EMOJI.logs : STATUS_EMOJI.noLogs} `;
}

function routeLinkUrl(r: ExtractedRoute): string {
  const orig = r.originalText;
  if (orig && /^https:\/\/connect\.comma\.ai\//i.test(orig)) return orig;
  if (orig) {
    const m = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?$/i);
    if (m && m[1] !== undefined) {
      const s1 = segmentToSeconds(parseInt(m[1], 10));
      const s2 = m[2] !== undefined ? segmentToSeconds(parseInt(m[2], 10)) : null;
      return `https://connect.comma.ai/${r.dongleId}/${r.routeName}/${s1}${s2 !== null ? '/' + s2 : ''}`;
    }
  }
  return `https://connect.comma.ai/${r.dongleId}/${r.routeName}`;
}

function routeShortForm(r: ExtractedRoute): string {
  const orig = r.originalText;
  const base = `${r.dongleId}/${r.routeName}`;
  if (orig) {
    const url = orig.match(/^https:\/\/connect\.comma\.ai\/[a-f0-9]{16}\/[a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?\/?$/i);
    if (url) {
      if (url[1] === undefined) return base;
      const seg1 = secondsToSegment(url[1]);
      if (url[2] === undefined) return `${base}/${seg1}`;
      const seg2 = secondsToSegment(url[2]);
      return `${base}/${seg1}/${seg2}`;
    }
    const hex = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}\/([a-f0-9]{8}--[a-f0-9]{10})$/i);
    if (hex) return `${base}/${hex[1]}`;
    const bare = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?$/i);
    if (bare && bare[1] !== undefined) {
      return bare[2] !== undefined ? `${base}/${bare[1]}/${bare[2]}` : `${base}/${bare[1]}`;
    }
  }
  return r.iteration ? `${base}/${r.iteration}` : base;
}

export function routeNumberLabel(routeNumber: number): string {
  return `**[Route ${routeNumber}]**`;
}

export function routeLinkMarkdown(r: ExtractedRoute): string {
  const url = routeLinkUrl(r);
  const short = routeShortForm(r);
  const original = r.originalText ?? short;
  const linkText = r.routeNumber ? `Route ${r.routeNumber}` : 'Route';
  return `${routeStatusEmoji(r)}[${linkText}](${url}) \u2014 \`${short}\` \u2014 ||\`${original}\`||`;
}

export function buildConfirmRows(
  routes: Array<{ dongleId: string; routeName: string; iteration?: string }>,
  ticketId: string,
  userId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const r of routes) {
    if (rows.length === 0 || rows[rows.length - 1].components.length >= 3) {
      rows.push(new ActionRowBuilder<ButtonBuilder>());
    }
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(encodeConfirmCustomId(ticketId, userId, r.dongleId, r.routeName, r.iteration))
        .setLabel(`Confirm ${r.dongleId.slice(0, 8)}`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('\uD83D\uDCCD'),
    );
  }
  return rows;
}

export function buildRefreshRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('refresh_routes')
      .setLabel('Refresh Status')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(STATUS_EMOJI.refresh),
  );
}

export function encodeConfirmCustomId(ticketId: string, userId: string, dongleId: string, routeName: string, iteration?: string): string {
  return `cr_${ticketId}_${userId}_${dongleId}_${routeName}${iteration ? '_' + iteration : ''}`;
}

export function parseConfirmCustomId(customId: string): { ticketId: string; userId: string; dongleId: string; routeName: string; iteration?: string } | null {
  const parts = customId.split('_');
  if (parts.length < 5 || parts[0] !== 'cr') return null;
  return { ticketId: parts[1], userId: parts[2], dongleId: parts[3], routeName: parts[4], iteration: parts[5] || undefined };
}

const REFRESH_COOLDOWN_MS = 60_000;
export const refreshCooldowns = new LRUCache<string, number>({ max: 500, ttl: REFRESH_COOLDOWN_MS });

async function postRouteMetadata(channel: ThreadChannel, dongleId: string, routeName: string): Promise<void> {
  const meta = await fetchRouteMetadata(dongleId, routeName);
  if (!meta) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle('Route Metadata')
    .addFields(
      { name: 'Route ID', value: `${dongleId}/${routeName}`, inline: true },
      { name: 'Start Time', value: `<t:${Math.floor(meta.start_time_utc_millis / 1000)}:f>`, inline: true },
      { name: 'End Time', value: `<t:${Math.floor(meta.end_time_utc_millis / 1000)}:f>`, inline: true },
      { name: 'Git Remote', value: meta.git_remote, inline: true },
      { name: 'Git Branch', value: formatGitBranch(meta.git_branch, meta.git_remote), inline: true },
      { name: 'Git Commit', value: formatGitCommit(meta.git_commit, meta.git_remote), inline: true },
      { name: 'Git Commit Date', value: meta.git_commit_date, inline: true },
      { name: 'Git Dirty', value: String(meta.git_dirty), inline: true },
    );
  await channel.send({ embeds: [embed] }).catch(err => log.warn({ err }, 'Failed to post route metadata'));
}

async function refreshRouteLine(line: string): Promise<string> {
  const shortMatch = line.match(/`([^`]+)`/);
  if (!shortMatch) return line;
  let components: RouteComponents;
  try {
    components = parseRouteComponents(shortMatch[1]);
  } catch {
    return line;
  }
  const v = await validateRoute(components.dongleId, components.routeName, components.startSegment, components.endSegment);
  if (!v.valid) return line;
  const emoji = routeStatusEmoji({
    dongleId: components.dongleId,
    routeName: components.routeName,
    public: v.public,
    rlogsAvailable: v.rlogsAvailable,
  });
  return emoji + line.replace(STATUS_PREFIX_RE, '');
}

export async function handleRefreshRoutes(interaction: import('discord.js').ButtonInteraction): Promise<void> {
  if (!(interaction.member instanceof GuildMember) || !interaction.member.roles.cache.has(loadConfig().staffRole)) {
    await interaction.reply({ content: 'Only staff can refresh route status.', flags: MessageFlags.Ephemeral });
    return;
  }

  const key = interaction.message.id;
  const remaining = refreshCooldowns.getRemainingTTL(key);
  if (remaining > 0) {
    await interaction.reply({
      content: `This tracker was just refreshed. Try again in ${Math.ceil(remaining / 1000)}s.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  refreshCooldowns.set(key, Date.now());

  await interaction.deferUpdate();

  const embed = interaction.message.embeds[0];
  if (!embed) {
    await interaction.followUp({ content: 'No route tracker embed to refresh.', flags: MessageFlags.Ephemeral });
    return;
  }

  const updated = EmbedBuilder.from(embed);
  for (const field of updated.data.fields ?? []) {
    if (field.name !== 'Route' && field.name !== 'Additional Routes') continue;
    const lines = field.value.split('\n');
    field.value = (await Promise.all(lines.map(refreshRouteLine))).join('\n');
  }

  await interaction.message.edit({ embeds: [updated] }).catch(err =>
    log.error({ err }, 'Failed to refresh route tracker'),
  );
}

async function findRouteThread(forum: ForumChannel, name: string): Promise<ThreadChannel | null> {
  const cached = forum.threads.cache.find(t => t.name === name);
  if (cached) return cached;
  try {
    const active = await forum.threads.fetchActive();
    return active.threads.find(t => t.name === name) ?? null;
  } catch {
    return null;
  }
}

export async function createRouteTrackerThread(
  guild: Guild,
  config: ReturnType<typeof loadConfig>,
  primaryRoute: ExtractedRoute | undefined,
  threadUrl: string,
  publicThreadTitle: string,
): Promise<{ url: string; threadId: string } | null> {
  const routesForum = await getForum(guild, config.routesChannelId);
  if (!routesForum) return null;

  const primaryLink = primaryRoute ? routeLinkMarkdown(primaryRoute) : null;

  const existing = await findRouteThread(routesForum, publicThreadTitle);
  if (existing) {
    if (primaryLink) {
      const starter = await existing.fetchStarterMessage();
      if (starter) {
        const embed = starter.embeds[0];
        if (embed) {
          const updated = EmbedBuilder.from(embed);
          if (!embed.fields?.some((f: { value?: string }) => f.value?.includes(primaryLink))) {
            const existingField = updated.data.fields?.find(f => f.name === 'Additional Routes');
            if (existingField) {
              existingField.value += `\n${primaryLink}`;
            } else {
              updated.addFields({ name: 'Additional Routes', value: primaryLink });
            }
            await starter.edit({ embeds: [updated] });
          }
        }
      }
    }
    if (primaryRoute?.public) {
      await postRouteMetadata(existing, primaryRoute.dongleId, primaryRoute.routeName);
    }
    return { url: existing.url, threadId: existing.id };
  }

  const routeEmbed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(publicThreadTitle)
    .setFooter({ text: STATUS_LEGEND })
    .setTimestamp();
  if (primaryLink) {
    routeEmbed.addFields({ name: 'Route', value: primaryLink });
  }

  const routesThread = await routesForum.threads.create({
    name: publicThreadTitle,
    message: { embeds: [routeEmbed] },
  });

  const starter = await routesThread.fetchStarterMessage();
  if (starter) {
    routeEmbed.addFields(
      { name: '\u200B', value: `${ORIGINAL_POST_PREFIX}(${threadUrl})` },
    );
    await starter.edit({ embeds: [routeEmbed], components: [buildRefreshRow()] });
  }

  if (primaryRoute?.public) {
    await postRouteMetadata(routesThread, primaryRoute.dongleId, primaryRoute.routeName);
  }

  return { url: routesThread.url, threadId: routesThread.id };
}

export async function addAdditionalRoutesToTracker(
  guild: Guild,
  threadId: string,
  additionalRoutes: ExtractedRoute[],
  sourceUrl?: string,
  sourceName?: string,
): Promise<void> {
  if (additionalRoutes.length === 0) return;
  try {
    const channel = await guild.channels.fetch(threadId);
    if (!channel?.isThread()) return;
    const starter = await channel.fetchStarterMessage();
    if (!starter) return;
    const embed = starter.embeds[0];
    if (!embed) return;
    const updated = EmbedBuilder.from(embed);
    const additionalField = updated.data.fields?.find(f => f.name === 'Additional Routes');
    const existingValue = additionalField?.value ?? '';
    const newRoutes = additionalRoutes.filter(r => {
      const short = routeShortForm(r);
      return !existingValue.includes(short);
    });
    const newLinks = newRoutes.map(r => {
      const base = routeLinkMarkdown(r);
      return sourceUrl && sourceName ? `${base} \u2014 [${sourceName}](${sourceUrl})` : base;
    });
    if (newLinks.length === 0) return;
    const links = newLinks.join('\n');
    if (additionalField) {
      additionalField.value += `\n${links}`;
    } else {
      const origPostIdx = updated.data.fields?.findIndex(
        f => f.value?.startsWith(ORIGINAL_POST_PREFIX),
      ) ?? -1;
      if (origPostIdx >= 0) {
        updated.spliceFields(origPostIdx, 0, { name: 'Additional Routes', value: links });
      } else {
        updated.addFields({ name: 'Additional Routes', value: links });
      }
    }
    await starter.edit({ embeds: [updated] });
    const postedMeta = new Set<string>();
    for (const r of newRoutes) {
      if (r.public) {
        const key = `${r.dongleId}/${r.routeName}`;
        if (!postedMeta.has(key)) {
          postedMeta.add(key);
          await postRouteMetadata(channel, r.dongleId, r.routeName);
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to add additional routes to tracker');
  }
}

export async function getForum(guild: Guild, id: string): Promise<ForumChannel | null> {
  const cached = guild.channels.cache.get(id);
  if (cached instanceof ForumChannel) return cached;
  try {
    const ch = await guild.channels.fetch(id);
    return ch instanceof ForumChannel ? ch : null;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch forum channel');
    return null;
  }
}
