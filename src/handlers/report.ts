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
} from 'discord.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getIndex } from '../wiki/wiki.js';
import { embedBatch } from '../wiki/embedder.js';
import { searchWiki, formatWikiResults } from '../wiki/searcher.js';
import { COLORS, dot } from '../util.js';

const log = createLogger('report');

interface ParsedConfirmRoute {
  ticketId: string;
  userId: string;
  dongleId: string;
  routeName: string;
  iteration?: string;
}

interface ExtractedRoute {
  dongleId: string;
  routeName: string;
  iteration?: string;
  // Identity for dedup and replacement is the lowercased originalText, so distinct text
  // forms of the same drive get separate route numbers.
  originalText?: string;
  isUrl?: boolean;
  routeNumber?: number;
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

// Matches dongle/route or dongle|route with optional iteration (used for scanning free-form text).
export const ROUTE_REGEX = /([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10})(?:\/(?:[a-f0-9]{8}--[a-f0-9]{10}|\d+(?:\/\d+)?))?/gi;

// Anchored regex for validating a single normalized route string (dongle_id/route_name[/iter_or_seg[/seg]]).
const ROUTE_ID_REGEX = /^([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10})(?:\/([a-f0-9]{8}--[a-f0-9]{10}|\d+(?:\/\d+)?))?$/i;

// Matches connect.comma.ai URLs with optional start[/end] seconds.
const CONNECT_URL_REGEX = /https:\/\/connect\.comma\.ai\/([a-f0-9]{16})\/([a-f0-9]{8}--[a-f0-9]{10})(?:\/(\d+)(?:\/(\d+))?)?/gi;

export function normalizeRouteInput(input: string): string {
  input = input.trim();

  if (input.startsWith('https://connect.comma.ai/')) {
    const path = input.slice('https://connect.comma.ai/'.length).replace(/\/+$/, '');
    const parts = path.split('/');
    if (parts.length === 2) return `${parts[0]}/${parts[1]}`;
    if (parts.length === 3) {
      const [dongleId, routeName, secStr] = parts;
      if (!/^\d+$/.test(secStr)) throw new Error(`Invalid seconds value in URL: "${secStr}"`);
      return `${dongleId}/${routeName}/${Math.floor(parseInt(secStr, 10) / 60)}`;
    }
    if (parts.length === 4) {
      const [dongleId, routeName, startStr] = parts;
      if (!/^\d+$/.test(startStr)) throw new Error(`Invalid seconds value in URL: "${startStr}"`);
      return `${dongleId}/${routeName}/${Math.floor(parseInt(startStr, 10) / 60)}`;
    }
    throw new Error(`Invalid connect.comma.ai URL format`);
  }

  const pipeMatch = input.match(/^([a-f0-9]{16})\|([a-f0-9]{8}--[a-f0-9]{10})$/i);
  if (pipeMatch) return `${pipeMatch[1]}/${pipeMatch[2]}`;

  const parts = input.split('/');
  if (parts.length >= 2 && parts.length <= 4) {
    if (!/^[a-f0-9]{16}$/i.test(parts[0]))
      throw new Error(`Invalid dongle ID "${parts[0]}": expected 16 hex characters.`);
    if (!/^[a-f0-9]{8}--[a-f0-9]{10}$/i.test(parts[1]))
      throw new Error(`Invalid route name "${parts[1]}": expected format like \`0000aaaa--1234567890\`.`);
    return input;
  }

  throw new Error(`Unrecognized route format: expected "dongleId/routeName[/seg]" or a connect.comma.ai URL`);
}

export function parseNormalizedRoute(input: string): ExtractedRoute | null {
  const match = input.match(ROUTE_ID_REGEX);
  if (!match) return null;
  // Numeric time-segments aren't part of route identity; only hex sub-routes count.
  const iter = match[3] && /^[a-f0-9]{8}--[a-f0-9]{10}$/i.test(match[3]) ? match[3] : undefined;
  return {
    dongleId: match[1],
    routeName: match[2],
    iteration: iter,
  };
}

// Captures: 1+2 = URL form (dongle, route); 3+4 = bare form (dongle, route).
const ANY_ROUTE_REGEX = /(?:https:\/\/connect\.comma\.ai\/([a-f0-9]{16})\/([a-f0-9]{8}--[a-f0-9]{10})|([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10}))(?:\/(?:[a-f0-9]{8}--[a-f0-9]{10}|\d+(?:\/\d+)?))?/gi;

function extractRouteIds(text: string): ExtractedRoute[] {
  const results: ExtractedRoute[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(ANY_ROUTE_REGEX.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const original = m[0];
    const key = original.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const isUrl = m[1] !== undefined;
    const dongle = isUrl ? m[1] : m[3];
    const route = isUrl ? m[2] : m[4];
    const iterMatch = !isUrl ? original.match(/\/([a-f0-9]{8}--[a-f0-9]{10})$/i) : null;
    results.push({
      dongleId: dongle,
      routeName: route,
      iteration: iterMatch?.[1],
      originalText: original,
      isUrl,
    });
  }
  return results;
}

// Lenient enough to catch malformed connect URLs so PII is stripped even if parsing fails.
const CONNECT_URL_STRIP_REGEX = /https?:\/\/connect\.comma\.ai\/[^\s)<>"']*/gi;

export function replaceRouteIds(
  text: string,
  routes: ExtractedRoute[],
): string {
  const labelByText = new Map<string, string>();
  for (const r of routes) {
    if (!r.originalText) continue;
    const key = r.originalText.toLowerCase();
    if (labelByText.has(key)) continue;
    // Unnumbered routes (dedicated) are stripped — already shown as the primary tracker entry.
    labelByText.set(key, r.routeNumber ? `**[Route ${r.routeNumber}]**` : '');
  }
  return text
    .replace(new RegExp(ANY_ROUTE_REGEX.source, 'gi'), match => labelByText.get(match.toLowerCase()) ?? '')
    .replace(CONNECT_URL_STRIP_REGEX, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

export function stripRouteIds(text: string): string {
  return text
    .replace(CONNECT_URL_REGEX, '')
    .replace(ROUTE_REGEX, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

export async function validateRoute(dongleId: string, routeName: string): Promise<{ valid: boolean; public: boolean }> {
  try {
    const res = await fetch(`https://api.comma.ai/v1/route/${dongleId}|${routeName}/files`);
    if (res.ok) return { valid: true, public: true };
    if (res.status === 403 || res.status === 401) return { valid: true, public: false };
  } catch (err) {
    log.warn({ err }, 'Route validation API unreachable');
  }
  return { valid: false, public: false };
}

export function formatRoute(dongleId: string, routeName: string, iteration?: string): string {
  return iteration ? `${dongleId}/${routeName}/${iteration}` : `${dongleId}/${routeName}`;
}

function routeLinkUrl(r: ExtractedRoute): string {
  const orig = r.originalText;
  if (orig && /^https:\/\/connect\.comma\.ai\//i.test(orig)) return orig;
  if (orig) {
    const m = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?$/i);
    if (m && m[1] !== undefined) {
      const s1 = parseInt(m[1], 10) * 60;
      const s2 = m[2] !== undefined ? parseInt(m[2], 10) * 60 : null;
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
      const seg1 = Math.floor(parseInt(url[1], 10) / 60);
      if (url[2] === undefined) return `${base}/${seg1}`;
      const seg2 = Math.floor(parseInt(url[2], 10) / 60);
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

function routeLinkMarkdown(r: ExtractedRoute): string {
  const url = routeLinkUrl(r);
  const short = routeShortForm(r);
  const original = r.originalText ?? short;
  const linkText = r.routeNumber ? `Route ${r.routeNumber}` : 'Route';
  return `[${linkText}](${url}) — \`${short}\` — ||\`${original}\`||`;
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

async function createRouteTrackerThread(
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
    return { url: existing.url, threadId: existing.id };
  }

  const routeEmbed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(publicThreadTitle)
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
    await starter.edit({ embeds: [routeEmbed] });
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
    const links = additionalRoutes.map(r => {
      const base = routeLinkMarkdown(r);
      return sourceUrl && sourceName ? `${base} — [${sourceName}](${sourceUrl})` : base;
    }).join('\n');
    if (!embed.fields?.some((f: { value?: string }) => f.value?.includes(links))) {
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
  interaction: ModalSubmitInteraction,
  params: {
    embed: EmbedBuilder;
    titleSource: string;
    wikiQuery: string;
    // Undefined for feedback/feature flows where all routes are "additional".
    dedicatedRoute?: ExtractedRoute & { valid: boolean; public: boolean };
    additionalRoutes: Array<ExtractedRoute & { valid: boolean; public: boolean }>;
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
  }

  await interaction.editReply({
    content: `${params.label} **${ticketId}** submitted! [View thread](${thread.url})`,
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

export async function handleBugSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const routeIdInput = interaction.fields.getTextInputValue('route_id');
  const observed = interaction.fields.getTextInputValue('observed');
  const expected = interaction.fields.getTextInputValue('expected');
  const reproIntent = interaction.fields.getTextInputValue('reproducibility_intent');
  const branchValues = interaction.fields.getStringSelectValues('current_branch');
  const branch = branchValues.length > 0 ? branchValues[0] : 'StarPilot';

  log.info({
    userId: interaction.user.id,
    type: 'bug',
    route: routeIdInput,
    branch,
    observed,
    expected,
    reproIntent,
  }, 'Bug report submitted');

  let normalizedRoute: string;
  try {
    normalizedRoute = normalizeRouteInput(routeIdInput);
  } catch (err) {
    await interaction.editReply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\n${err instanceof Error ? err.message : 'Use the format `dongle_id/route_name` or a connect.comma.ai URL.'}`,
    });
    return;
  }

  const dedicatedRoute = parseNormalizedRoute(normalizedRoute);
  if (!dedicatedRoute) {
    await interaction.editReply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\nUse the format \`dongle_id/route_name\` (e.g. \`a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8\`) or a connect.comma.ai URL.`,
    });
    return;
  }
  // Preserve verbatim input so the tracker shows what the user wrote.
  const dedicatedTrimmed = routeIdInput.trim();
  dedicatedRoute.originalText = dedicatedTrimmed;
  dedicatedRoute.isUrl = /^https:\/\/connect\.comma\.ai\//i.test(dedicatedTrimmed);

  const allRoutes: ExtractedRoute[] = [];
  const seenKeys = new Set<string>();
  seenKeys.add(dedicatedTrimmed.toLowerCase());
  allRoutes.push(dedicatedRoute);

  const allText = [observed, expected, reproIntent].join('\n');
  for (const r of extractRouteIds(allText)) {
    const key = (r.originalText ?? '').toLowerCase();
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      allRoutes.push(r);
    }
  }

  // Validate all routes in parallel.
  const validatedRoutes: Array<ExtractedRoute & { valid: boolean; public: boolean }> = [];
  for (const v of await Promise.all(allRoutes.map(r => validateRoute(r.dongleId, r.routeName)))) {
    validatedRoutes.push({ ...allRoutes[validatedRoutes.length], ...v });
  }

  // Dedicated route must be valid.
  if (!validatedRoutes[0].valid) {
    await interaction.editReply({
      content: `The route you entered doesn't appear to exist:\n\`${routeIdInput}\`\n\nPlease double-check the Route ID and try again.`,
    });
    return;
  }

  // Number all extracted routes (even invalid ones) so format-matching URLs still get redacted.
  const dedicatedValidated = validatedRoutes[0];
  const numberedAdditional = validatedRoutes.slice(1).map((r, i) => ({ ...r, routeNumber: i + 1 }));

  const replacementRoutes: ExtractedRoute[] = [dedicatedValidated, ...numberedAdditional];
  const cleanObserved = replaceRouteIds(observed, replacementRoutes);
  const cleanExpected = replaceRouteIds(expected, replacementRoutes);
  const cleanReproIntent = replaceRouteIds(reproIntent, replacementRoutes);

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

  let nowPublic = false;
  try {
    const res = await fetch(`https://api.comma.ai/v1/route/${dongleId}|${routeName}/files`);
    nowPublic = res.ok;
  } catch (err) {
    log.warn({ err }, 'Route check API unreachable on confirm');
  }

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
      guild, config, { dongleId, routeName, iteration }, thread.url, thread.name,
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
  const validatedRoutes: Array<ExtractedRoute & { valid: boolean; public: boolean }> = [];
  for (const v of await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName)))) {
    validatedRoutes.push({ ...routes[validatedRoutes.length], ...v });
  }
  // Number every extracted route (even invalid) so format-matching URLs still get redacted.
  const numberedRoutes = validatedRoutes.map((r, i) => ({ ...r, routeNumber: i + 1 }));
  const cleanContent = replaceRouteIds(content, numberedRoutes);

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
