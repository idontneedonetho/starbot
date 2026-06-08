import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  Guild,
} from 'discord.js';
import {
  ModalBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  EmbedBuilder,
  MessageFlags,
  ForumChannel,
  ThreadChannel,
  StringSelectMenuBuilder,
  GuildMember,
} from 'discord.js';
import { LRUCache } from 'lru-cache';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createStore } from '../store.js';
import { getIndex } from '../wiki/wiki.js';
import { embedBatch } from '../wiki/embedder.js';
import { searchWiki, formatWikiResults } from '../wiki/searcher.js';
import { COLORS, dot, formatGitBranch, formatGitCommit } from '../util.js';
import {
  parseRouteComponents,
  extractRouteIds,
  replaceRouteIds,
  validateRoute,
  fetchRouteMetadata,
  secondsToSegment,
  segmentToSeconds,
  type RouteComponents,
  type ExtractedRoute,
  type RouteValidation,
  type RlogCheckResult,
} from '../comma.js';

const log = createLogger('report');

interface ParsedConfirmRoute {
  ticketId: string;
  userId: string;
  dongleId: string;
  routeName: string;
  iteration?: string;
}

export const TRACKER_FIELD_PREFIX = '[Mods Route Tracker →]';
export const ORIGINAL_POST_PREFIX = '[Original Post →]';

function encodeConfirmCustomId(ticketId: string, userId: string, dongleId: string, routeName: string, iteration?: string): string {
  return `cr_${ticketId}_${userId}_${dongleId}_${routeName}${iteration ? '_' + iteration : ''}`;
}

function parseConfirmCustomId(customId: string): ParsedConfirmRoute | null {
  const parts = customId.split('_');
  if (parts.length < 5 || parts[0] !== 'cr') return null;
  return { ticketId: parts[1], userId: parts[2], dongleId: parts[3], routeName: parts[4], iteration: parts[5] || undefined };
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

export function resolveTagIds(forum: ForumChannel, names: string[]): string[] {
  return names
    .map(name => forum.availableTags.find(t => t.name === name)?.id)
    .filter((id): id is string => id != null);
}

// Specific guidance for an rlog-check failure; tells the user which segment(s) to upload.
function rlogFailureMessage(check: RlogCheckResult): string {
  if (check.mode === 'whole') {
    return 'All the logs must be uploaded. If you only have a few moments in the route to review, please use a route link / ID that is segmented.';
  }
  const segList = check.missing.join(', ');
  const noun = check.missing.length === 1 ? 'segment' : 'segments';
  return `The rlogs for ${noun} **${segList}** don't appear to be uploaded yet. Please upload the logs for ${noun} **${segList}** from your device, then check again.`;
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

// Always segment-style; URL seconds are converted via Math.floor(s/60).
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

// Status emojis shared by the route-tracker renderer, the legend, and the refresh prefix-stripper.
const STATUS_EMOJI = {
  public: '🌎',
  private: '⚫',
  logs: '📜',
  noLogs: '⚠️',
  refresh: '🔄',
} as const;

// One-line legend rendered under the tracker's Original Post link (subtext markdown).
const STATUS_LEGEND =
  `${STATUS_EMOJI.public} = public | ${STATUS_EMOJI.private} = private | ` +
  `${STATUS_EMOJI.logs} = logs | ${STATUS_EMOJI.noLogs} = no/partial logs`;

// Matches the leading status-emoji prefix produced by routeStatusEmoji, so refresh can swap it.
const STATUS_PREFIX_RE = new RegExp(
  `^(?:${STATUS_EMOJI.public} (?:${STATUS_EMOJI.logs}|${STATUS_EMOJI.noLogs}) |${STATUS_EMOJI.private} )`,
  'u',
);

// Leading status emojis: 🌎 public / ⚫ private; when public, 📜 rlogs present / ⚠️ rlogs missing.
function routeStatusEmoji(r: ExtractedRoute): string {
  if (r.public === undefined) return '';
  if (!r.public) return `${STATUS_EMOJI.private} `;
  return `${STATUS_EMOJI.public} ${r.rlogsAvailable ? STATUS_EMOJI.logs : STATUS_EMOJI.noLogs} `;
}

// Replacement label for a numbered route reference scrubbed from report text (Discord markdown).
function routeNumberLabel(routeNumber: number): string {
  return `**[Route ${routeNumber}]**`;
}

function routeLinkMarkdown(r: ExtractedRoute): string {
  const url = routeLinkUrl(r);
  const short = routeShortForm(r);
  const original = r.originalText ?? short;
  const linkText = r.routeNumber ? `Route ${r.routeNumber}` : 'Route';
  return `${routeStatusEmoji(r)}[${linkText}](${url}) — \`${short}\` — ||\`${original}\`||`;
}

function buildConfirmRows(
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
        .setEmoji('📍'),
    );
  }
  return rows;
}

async function addWikiSuggestions(embed: EmbedBuilder, query: string): Promise<void> {
  try {
    const wikiIndex = getIndex();
    if (wikiIndex) {
      const wikiResults = await searchWiki(wikiIndex, query);
      if (wikiResults.length > 0) {
        embed.addFields({ name: '📖 Potentially Related Wiki Articles', value: formatWikiResults(wikiResults) });
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to fetch wiki suggestions');
  }
}

export function buildActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`additional_report_${ticketId}`)
      .setLabel('Additional Report')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📝'),
    new ButtonBuilder()
      .setCustomId(`assign_${ticketId}`)
      .setLabel('Assign')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('👤'),
    new ButtonBuilder()
      .setCustomId(`merge_${ticketId}`)
      .setLabel('Merge')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔀'),
    new ButtonBuilder()
      .setCustomId(`close_${ticketId}`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
}

function buildRefreshRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('refresh_routes')
      .setLabel('Refresh Status')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(STATUS_EMOJI.refresh),
  );
}

// Per-tracker cooldown for the Refresh Status button. LRU + TTL means entries auto-expire once the
// cooldown elapses, so a key's mere presence signals "still cooling down" (no manual sweeping).
const REFRESH_COOLDOWN_MS = 60_000;
const refreshCooldowns = new LRUCache<string, number>({ max: 500, ttl: REFRESH_COOLDOWN_MS });

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

// Re-validate one tracker route line and swap its leading status emoji; leaves the line otherwise
// intact. Returns the line unchanged if it has no parseable route or the route can't be validated.
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
  // Keep the prior status on a transient API failure rather than flipping it to "private".
  if (!v.valid) return line;
  const emoji = routeStatusEmoji({
    dongleId: components.dongleId,
    routeName: components.routeName,
    public: v.public,
    rlogsAvailable: v.rlogsAvailable,
  });
  return emoji + line.replace(STATUS_PREFIX_RE, '');
}

// Staff-only: re-check every route in the tracker embed and update the status emojis in place.
export async function handleRefreshRoutes(interaction: ButtonInteraction): Promise<void> {
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

function formatThreadTitle(emoji: string, label: string, title: string | null, ticketId: string): string {
  const MAX = 100;
  if (title) {
    const raw = `${emoji} ${label} - ${title} (${ticketId})`;
    if (raw.length <= MAX) return raw;
    // Derive budget from the actual surrounding chars to avoid manual-count drift.
    const overhead = `${emoji} ${label} -  (${ticketId})`.length;
    const maxTitleLen = MAX - overhead;
    if (maxTitleLen <= 1) return `${emoji} ${label} - ${ticketId}`;
    const truncated = title.slice(0, maxTitleLen - 1) + '…';
    return `${emoji} ${label} - ${truncated} (${ticketId})`;
  }
  return `${emoji} ${label} - ${ticketId}`;
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
    const additionalField = embed.fields?.find(f => f.name === 'Additional Routes');
    const existingValue = additionalField?.value ?? '';
    const newRoutes = additionalRoutes.filter(r => {
      const short = routeShortForm(r);
      return !existingValue.includes(short);
    });
    const newLinks = newRoutes.map(r => {
      const base = routeLinkMarkdown(r);
      return sourceUrl && sourceName ? `${base} — [${sourceName}](${sourceUrl})` : base;
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
      await starter.edit({ embeds: [updated] });
    }
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

function isContentWord(w: string): boolean {
  if (w.length >= 4) return true;
  if (w.length >= 3 && w === w.toUpperCase() && /[A-Z]/.test(w[0])) return true;
  if (w.includes("'t")) return true;
  return false;
}

function getNGrams(words: string[], n: number): { phrase: string; start: number; len: number }[] {
  const result: { phrase: string; start: number; len: number }[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    result.push({ phrase: words.slice(i, i + n).join(' '), start: i, len: n });
  }
  return result;
}

async function generateThreadTitle(input: string): Promise<string | null> {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  const allWords = trimmed.split(/[^a-zA-Z0-9']+/).filter(w => w.length > 0);
  if (allWords.length === 0) return null;

  const words = allWords.length > 50 ? allWords.slice(0, 50) : allWords;

  if (words.length <= 10) {
    return words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  }

  const ngrams2 = getNGrams(words, 2);
  const ngrams3 = getNGrams(words, 3);
  const ngrams = [...ngrams2, ...ngrams3];

  const [textEmb, ...ngramEmbs] = await embedBatch([trimmed, ...ngrams.map(g => g.phrase)]);

  const scoredNgrams = ngrams.map((g, i) => ({ ...g, score: dot(textEmb, ngramEmbs[i]) }));

  const wordScores = new Array(words.length).fill(0);
  for (const sg of scoredNgrams) {
    for (let j = 0; j < sg.len; j++) {
      const idx = sg.start + j;
      if (idx < words.length) {
        wordScores[idx] = Math.max(wordScores[idx], sg.score);
      }
    }
  }

  const seen = new Map<string, { word: string; score: number; index: number }>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!isContentWord(w)) continue;
    const lower = w.toLowerCase();
    const existing = seen.get(lower);
    if (!existing || wordScores[i] > existing.score) {
      seen.set(lower, { word: w, score: wordScores[i], index: i });
    }
  }

  const scored = [...seen.values()].sort((a, b) => b.score - a.score);

  const top10 = scored
    .slice(0, 10)
    .sort((a, b) => a.index - b.index);

  if (top10.length === 0) return null;

  return top10.map(({ word }) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

async function submitReport(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  params: {
    embed: EmbedBuilder;
    titleSource: string;
    wikiQuery: string;
    // Undefined for feedback/feature flows where all routes are "additional".
    dedicatedRoute?: ExtractedRoute & RouteValidation;
    additionalRoutes: Array<ExtractedRoute & RouteValidation>;
    label: string;
    emoji: string;
    tagNames: string[];
    primaryNonPublicRoute?: ExtractedRoute;
    footerNote?: string;
  },
): Promise<void> {
  const config = loadConfig();
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) {
    await interaction.editReply({ content: 'Forum channel not found. Contact an admin.' });
    return;
  }

  const generatedTitle = await generateThreadTitle(params.titleSource).catch(() => null);

  const tagIds = params.tagNames.length > 0 ? resolveTagIds(forum, params.tagNames) : undefined;

  let thread;
  try {
    thread = await forum.threads.create({
      name: formatThreadTitle(params.emoji, params.label, generatedTitle, '...'),
      message: { content: `<@${interaction.user.id}>`, embeds: [params.embed] },
      appliedTags: tagIds,
    });
  } catch (err) {
    log.error({ err }, 'Failed to create thread');
    await interaction.editReply({ content: 'Failed to create thread. Contact an admin.' });
    return;
  }

  const ticketId = String(parseInt(thread.id.slice(-7), 10));

  try {
    await thread.edit({ name: formatThreadTitle(params.emoji, params.label, generatedTitle, ticketId) });
  } catch (err) {
    log.error({ err }, 'Failed to rename thread');
  }

  params.embed.setTitle(`${params.label} ${ticketId}`);

  const dedicatedPublic = params.dedicatedRoute?.valid && params.dedicatedRoute.public ? params.dedicatedRoute : undefined;
  const additionalPublic = params.additionalRoutes.filter(r => r.valid && r.public);
  if (dedicatedPublic || additionalPublic.length > 0) {
    const tracker = await createRouteTrackerThread(
      guild, config, dedicatedPublic, thread.url, thread.name,
    );
    if (tracker) {
      params.embed.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
      if (additionalPublic.length > 0) {
        await addAdditionalRoutesToTracker(guild, tracker.threadId, additionalPublic);
      }
    }
  }

  const nonPublic = params.additionalRoutes.filter(r => r.valid && !r.public);
  if (params.primaryNonPublicRoute) {
    const btn = new ButtonBuilder()
      .setCustomId(encodeConfirmCustomId(ticketId, interaction.user.id, params.primaryNonPublicRoute.dongleId, params.primaryNonPublicRoute.routeName, params.primaryNonPublicRoute.iteration))
      .setLabel('Confirm Route')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📍');
    await thread.send({
      content: `<@${interaction.user.id}> Your route is valid but not yet public. Once you've made it public, click the button below to link it to this report.\n\nNeed help? Follow [these instructions](<https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting>).`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)],
    }).catch(err => log.error({ err }, 'Failed to send primary confirm button'));
  }

  const remainingNonPublic = params.primaryNonPublicRoute
    ? nonPublic.filter(r => r.dongleId !== params.primaryNonPublicRoute!.dongleId || r.routeName !== params.primaryNonPublicRoute!.routeName)
    : nonPublic;
  if (remainingNonPublic.length > 0) {
    const confirmRows = buildConfirmRows(remainingNonPublic, ticketId, interaction.user.id);
    await thread.send({
      content: `<@${interaction.user.id}> Some additional routes are not yet public. Once you've made them public, click the button below to link them to this report.`,
      components: confirmRows,
    }).catch(err => log.error({ err }, 'Failed to send additional confirm buttons'));
  }

  await addWikiSuggestions(params.embed, params.wikiQuery);
  const starter = await thread.fetchStarterMessage();
  if (starter) {
    const actionRow = buildActionRow(ticketId);
    await starter.edit({ embeds: [params.embed], components: [actionRow] }).catch(err => {
      log.error({ err }, 'Failed to edit starter message');
    });
    await starter.pin().catch(err => {
      log.error({ err }, 'Failed to pin starter message');
    });
  }

  await interaction.editReply({
    content: `${params.label} **${ticketId}** submitted! [View thread](${thread.url})`,
    components: [],
  });
}

export async function handleBugButton(interaction: ButtonInteraction) {
  await showBugModal(interaction);
}

export async function handleFeedbackButton(interaction: ButtonInteraction) {
  await showFeedbackModal(interaction, 'Feedback');
}

export async function handleFeatureButton(interaction: ButtonInteraction) {
  await showFeedbackModal(interaction, 'Feature Request');
}

async function showBugModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder().setCustomId('bug_modal').setTitle('Submit Bug Report');

  const routeIdInput = new TextInputBuilder({
    custom_id: 'route_id',
    style: TextInputStyle.Short,
    placeholder: 'dongle_id/route_name or connect.comma.ai URL',
    required: true,
    max_length: 256,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Route ID').setDescription('Visible only to server admins').setTextInputComponent(routeIdInput));

  const branchSelect = new StringSelectMenuBuilder()
    .setCustomId('current_branch')
    .setPlaceholder('Select a branch\u2026')
    .setMinValues(1)
    .addOptions(
      { label: 'StarPilot', value: 'StarPilot', description: 'The default branch, if you\'re unsure, pick this.', default: true },
      { label: 'Dom', value: 'Dom', description: 'Bleeding edge' },
    );
  modal.addLabelComponents(new LabelBuilder().setLabel('Branch').setDescription('The branch you were on when you experienced this issue').setStringSelectMenuComponent(branchSelect));

  const observedInput = new TextInputBuilder({
    custom_id: 'observed',
    style: TextInputStyle.Paragraph,
    placeholder: 'What happened?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Observed Behavior').setTextInputComponent(observedInput));

  const expectedInput = new TextInputBuilder({
    custom_id: 'expected',
    style: TextInputStyle.Paragraph,
    placeholder: 'What should have happened?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Expected Behavior').setTextInputComponent(expectedInput));

  const reproIntentInput = new TextInputBuilder({
    custom_id: 'reproducibility_intent',
    style: TextInputStyle.Paragraph,
    placeholder: 'Can you reproduce it? What is your ideal outcome? Any additional details?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Reproducibility, Intent & Details').setTextInputComponent(reproIntentInput));

  await interaction.showModal(modal);
}

async function showFeedbackModal(interaction: ButtonInteraction, type: string) {
  const modal = new ModalBuilder()
    .setCustomId(type === 'Feedback' ? 'feedback_modal' : 'feature_modal')
    .setTitle(type === 'Feedback' ? 'Submit Feedback' : 'Submit Feature Request');

  const input = new TextInputBuilder({
    custom_id: 'content',
    style: TextInputStyle.Paragraph,
    placeholder: `Tell us about your ${type.toLowerCase()}...`,
    required: true,
    min_length: 10,
    max_length: 2000,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Your Thoughts').setTextInputComponent(input));

  await interaction.showModal(modal);
}

interface BugReportInput {
  routeIdInput: string;
  observed: string;
  expected: string;
  reproIntent: string;
  branch: string;
}

interface PendingBugReport extends BugReportInput {
  userId: string;
}

const PENDING_BUG_TTL_MS = 15 * 60 * 1000;

// Bug reports whose primary route failed the rlog check, awaiting "Check Again" / "Force Proceed".
// Persisted (see store.ts) so a bot restart doesn't drop pending gates; entries self-expire via the
// TTL, so there's no manual sweep.
const pendingStore = createStore<PendingBugReport>('pending-bug-reports', { ttl: PENDING_BUG_TTL_MS });

export async function handleBugSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const branchValues = interaction.fields.getStringSelectValues('current_branch');
  const input: BugReportInput = {
    routeIdInput: interaction.fields.getTextInputValue('route_id'),
    observed: interaction.fields.getTextInputValue('observed'),
    expected: interaction.fields.getTextInputValue('expected'),
    reproIntent: interaction.fields.getTextInputValue('reproducibility_intent'),
    branch: branchValues.length > 0 ? branchValues[0] : 'StarPilot',
  };

  log.info({
    userId: interaction.user.id,
    type: 'bug',
    route: input.routeIdInput,
    branch: input.branch,
    observed: input.observed,
    expected: input.expected,
    reproIntent: input.reproIntent,
  }, 'Bug report submitted');

  await processBugReport(interaction, input, false);
}

// Validates routes, gates on rlog availability, and (when cleared) creates the report.
// Shared by the modal submit and the rlog gate buttons; `force` skips the rlog gate.
async function processBugReport(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  input: BugReportInput,
  force: boolean,
): Promise<void> {
  const { routeIdInput, observed, expected, reproIntent, branch } = input;

  let components: RouteComponents;
  try {
    components = parseRouteComponents(routeIdInput);
  } catch (err) {
    await interaction.editReply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\n${err instanceof Error ? err.message : 'Use the format `dongle_id/route_name` or a connect.comma.ai URL.'}`,
    });
    return;
  }

  // Preserve verbatim input so the tracker shows what the user wrote.
  const dedicatedTrimmed = routeIdInput.trim();
  const dedicatedRoute: ExtractedRoute = {
    dongleId: components.dongleId,
    routeName: components.routeName,
    iteration: components.iteration,
    originalText: dedicatedTrimmed,
    isUrl: /^https:\/\/connect\.comma\.ai\//i.test(dedicatedTrimmed),
  };

  const allRoutes: ExtractedRoute[] = [dedicatedRoute];
  const seenKeys = new Set<string>([dedicatedTrimmed.toLowerCase()]);
  const allText = [observed, expected, reproIntent].join('\n');
  for (const r of extractRouteIds(allText)) {
    const key = (r.originalText ?? '').toLowerCase();
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      allRoutes.push(r);
    }
  }

  // Validate all routes in parallel; the dedicated route is checked against its segment bounds.
  const validations = await Promise.all(
    allRoutes.map((r, i) =>
      i === 0
        ? validateRoute(r.dongleId, r.routeName, components.startSegment, components.endSegment)
        : validateRoute(r.dongleId, r.routeName),
    ),
  );
  const validatedRoutes = allRoutes.map((r, i) => ({ ...r, ...validations[i] }));
  const dedicatedValidated = validatedRoutes[0];

  // Dedicated route must exist.
  if (!dedicatedValidated.valid) {
    await interaction.editReply({
      content: `The route you entered doesn't appear to exist:\n\`${routeIdInput}\`\n\nPlease double-check the Route ID and try again.`,
    });
    return;
  }

  // Gate on rlog availability for a public dedicated route. Non-public routes keep the existing
  // Confirm Route flow, so they fall through (rlogCheck is only set when the route is public).
  if (!force && dedicatedValidated.public && dedicatedValidated.rlogCheck && !dedicatedValidated.rlogsAvailable) {
    const token = interaction.id;
    await pendingStore.set(token, { ...input, userId: interaction.user.id });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rlogchk_${token}`)
        .setLabel('Check Again')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔄'),
      new ButtonBuilder()
        .setLabel('Need help?')
        .setStyle(ButtonStyle.Link)
        .setURL('https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting'),
      new ButtonBuilder()
        .setCustomId(`rlogfrc_${token}`)
        .setLabel("I know what I'm doing, submit anyway")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({ content: rlogFailureMessage(dedicatedValidated.rlogCheck), components: [row] });
    return;
  }

  // Number all extracted routes (even invalid ones) so format-matching URLs still get redacted.
  const numberedAdditional = validatedRoutes.slice(1).map((r, i) => ({ ...r, routeNumber: i + 1 }));

  const replacementRoutes: ExtractedRoute[] = [dedicatedValidated, ...numberedAdditional];
  const cleanObserved = replaceRouteIds(observed, replacementRoutes, routeNumberLabel);
  const cleanExpected = replaceRouteIds(expected, replacementRoutes, routeNumberLabel);
  const cleanReproIntent = replaceRouteIds(reproIntent, replacementRoutes, routeNumberLabel);

  const reportEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .addFields(
      { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Branch', value: branch, inline: true },
      { name: 'Observed Behavior', value: cleanObserved },
      { name: 'Expected Behavior', value: cleanExpected },
      { name: 'Reproducibility, Intent & Details', value: cleanReproIntent },
    )
    .setTimestamp();

  const primaryNonPublic = dedicatedValidated.valid && !dedicatedValidated.public ? dedicatedValidated : undefined;

  await submitReport(interaction, {
    embed: reportEmbed,
    titleSource: cleanObserved,
    wikiQuery: `${cleanObserved} ${cleanExpected} ${cleanReproIntent}`,
    dedicatedRoute: dedicatedValidated,
    additionalRoutes: numberedAdditional,
    label: 'Bug Report',
    emoji: '🐛',
    tagNames: ['OPEN', 'BUG'],
    primaryNonPublicRoute: primaryNonPublic,
    footerNote: ' with ticket ID / wiki / route link',
  });
}

export async function handleRlogRecheck(interaction: ButtonInteraction) {
  await handleRlogGateButton(interaction, false);
}

export async function handleRlogForceProceed(interaction: ButtonInteraction) {
  await handleRlogGateButton(interaction, true);
}

async function handleRlogGateButton(interaction: ButtonInteraction, force: boolean): Promise<void> {
  const token = interaction.customId.split('_')[1];
  const pending = await pendingStore.get(token);
  if (!pending) {
    await interaction.reply({
      content: 'This request has expired. Please submit a new bug report.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== pending.userId) {
    await interaction.reply({
      content: 'Only the original reporter can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Keep the pending entry on failure so the buttons remain usable; stale entries expire via TTL.
  await interaction.deferUpdate();
  await processBugReport(interaction, pending, force);
}

export async function handleConfirmRoute(interaction: ButtonInteraction) {
  const parsed = parseConfirmCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: 'Invalid or expired confirmation button.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { ticketId, userId, dongleId, routeName, iteration } = parsed;

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'Only the original reporter can confirm the route.', flags: MessageFlags.Ephemeral });
    return;
  }

  const routeUrl = `https://connect.comma.ai/${dongleId}/${routeName}`;

  const confirmCheck = await validateRoute(dongleId, routeName);
  const nowPublic = confirmCheck.public;

  const thread = interaction.channel;
  if (!thread || !thread.isThread()) {
    await interaction.reply({ content: 'This button can only be used from the report thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!nowPublic) {
    await interaction.reply({
      content: `Your route is still not public. Make sure it's accessible on [connect.comma.ai](${routeUrl}) and try again.\n\nFollow [these instructions](<https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting>) to make your route public.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = loadConfig();

  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await interaction.reply({ content: 'Could not find the report starter message.', flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = starter.embeds[0];
  if (!embed) {
    await interaction.reply({ content: 'Could not find the report embed.', flags: MessageFlags.Ephemeral });
    return;
  }

  const updated = EmbedBuilder.from(embed);

  // Create routes forum thread and cross-link.
  const guild = interaction.guild;
  let routesThreadUrl: string | null = null;
  if (guild) {
    const result = await createRouteTrackerThread(
      guild, config,
      { dongleId, routeName, iteration, public: true, rlogsAvailable: confirmCheck.rlogsAvailable },
      thread.url, thread.name,
    );
    if (result) {
      routesThreadUrl = result.url;
      if (!embed.fields?.some((f: { value?: string }) => f.value?.includes(result.url))) {
        updated.addFields(
          { name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${result.url})` },
        );
      }
    }
  }

  await starter.edit({ embeds: [updated] });

  const content = `✅ Route confirmed and linked to **${ticketId}**.${routesThreadUrl ? ` [Mods Route Tracker →](${routesThreadUrl})` : ''}`;
  await interaction.update({ content, components: [] });
}

export async function handleFeedbackSubmit(interaction: ModalSubmitInteraction, type: 'feedback' | 'feature') {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const content = interaction.fields.getTextInputValue('content');

  const emoji = type === 'feedback' ? '💬' : '✨';
  const label = type === 'feedback' ? 'Feedback' : 'Feature Request';

  log.info({
    userId: interaction.user.id,
    type,
    content,
  }, `${label} submitted`);

  // Scan and validate route IDs before stripping so we can number them.
  const routes = extractRouteIds(content);
  const validatedRoutes: Array<ExtractedRoute & RouteValidation> = [];
  for (const v of await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName)))) {
    validatedRoutes.push({ ...routes[validatedRoutes.length], ...v });
  }
  // Number every extracted route (even invalid) so format-matching URLs still get redacted.
  const numberedRoutes = validatedRoutes.map((r, i) => ({ ...r, routeNumber: i + 1 }));
  const cleanContent = replaceRouteIds(content, numberedRoutes, routeNumberLabel);

  const embed = new EmbedBuilder()
    .setColor(type === 'feedback' ? COLORS.green : COLORS.blurple)
    .setTitle(label)
    .setDescription(cleanContent.length > 4096 ? cleanContent.slice(0, 4093) + '...' : cleanContent)
    .addFields({ name: 'By', value: `<@${interaction.user.id}>`, inline: true })
    .setTimestamp();

  await submitReport(interaction, {
    embed,
    titleSource: cleanContent,
    wikiQuery: cleanContent,
    additionalRoutes: numberedRoutes,
    label,
    emoji,
    tagNames: type === 'feedback' ? ['OPEN', 'FEEDBACK'] : ['OPEN', 'FEATURE REQUEST'],
  });
}
