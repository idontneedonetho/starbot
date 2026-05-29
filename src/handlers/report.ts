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
} from 'discord.js';
import { loadConfig } from '../config.js';
import { getIndex } from '../wiki/wiki.js';
import { embedBatch } from '../wiki/embedder.js';
import { searchWiki, formatWikiResults } from '../wiki/searcher.js';
import { COLORS, dot } from '../util.js';

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
    console.warn('[report] Failed to fetch forum channel:', err);
    return null;
  }
}

export function resolveTagIds(forum: ForumChannel, names: string[]): string[] {
  return names
    .map(name => forum.availableTags.find(t => t.name === name)?.id)
    .filter((id): id is string => id != null);
}

// Matches dongle/route or dongle|route with optional iteration (used for scanning free-form text).
export const ROUTE_REGEX = /([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10})(?:\/([a-f0-9]{8}--[a-f0-9]{10}|\d+))?/gi;

// Anchored regex for validating a single normalized route string (dongle_id/route_name[/iteration]).
const ROUTE_ID_REGEX = /^([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10})(?:\/([a-f0-9]{8}--[a-f0-9]{10}|\d+))?$/i;

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
  return {
    dongleId: match[1],
    routeName: match[2],
    iteration: match[3],
  };
}

function extractRouteIds(text: string): ExtractedRoute[] {
  const results: ExtractedRoute[] = [];
  const seen = new Set<string>();

  const urlRegex = new RegExp(CONNECT_URL_REGEX.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = urlRegex.exec(text)) !== null) {
    let normalized: string;
    try {
      normalized = normalizeRouteInput(m[0]);
    } catch {
      continue;
    }
    const parsed = parseNormalizedRoute(normalized);
    if (!parsed) continue;
    const key = formatRoute(parsed.dongleId, parsed.routeName, parsed.iteration);
    if (seen.has(key)) continue;
    seen.add(key);
    seen.add(formatRoute(parsed.dongleId, parsed.routeName));
    results.push(parsed);
  }

  const regex = new RegExp(ROUTE_REGEX.source, 'gi');
  while ((m = regex.exec(text)) !== null) {
    const key = formatRoute(m[1], m[2], m[3]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ dongleId: m[1], routeName: m[2], iteration: m[3] });
  }

  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceRouteIds(
  text: string,
  validRoutes: Array<ExtractedRoute & { routeNumber: number }>,
): string {
  let result = text;
  // Process iteration routes first; bare-route regexes also use negative lookaheads as a
  // second line of defence so they don't subsume more-specific iteration patterns.
  const sorted = [...validRoutes].sort((a, b) => (b.iteration ? 1 : 0) - (a.iteration ? 1 : 0));
  for (const { dongleId, routeName, iteration, routeNumber } of sorted) {
    const label = `**[ROUTE ${routeNumber}]**`;
    const d = escapeRegex(dongleId);
    const r = escapeRegex(routeName);
    if (iteration) {
      const i = escapeRegex(iteration);
      // URL: match any URL that has at least one numeric segment (seconds → segment conversion
      // may differ, so we claim all segmented URLs for this dongle/route).
      // Bare: match exactly this route's iteration.
      result = result
        .replace(new RegExp(`https://connect\\.comma\\.ai/${d}/${r}/\\d+(?:/\\d+)?`, 'gi'), label)
        .replace(new RegExp(`${d}[/|]${r}/${i}`, 'gi'), label);
    } else {
      // URL: only match the base URL — stop before any trailing slash (would be a segment).
      // Bare: only match when not immediately followed by an iteration suffix.
      result = result
        .replace(new RegExp(`https://connect\\.comma\\.ai/${d}/${r}(?!/)`, 'gi'), label)
        .replace(new RegExp(`${d}[/|]${r}(?!/(?:[a-f0-9]{8}--[a-f0-9]{10}|\\d+))`, 'gi'), label);
    }
  }
  return result
    .replace(new RegExp(CONNECT_URL_REGEX.source, 'gi'), '')
    .replace(new RegExp(ROUTE_REGEX.source, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripRouteIds(text: string): string {
  return text
    .replace(CONNECT_URL_REGEX, '')
    .replace(ROUTE_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function validateRoute(dongleId: string, routeName: string): Promise<{ valid: boolean; public: boolean }> {
  try {
    const res = await fetch(`https://api.comma.ai/v1/route/${dongleId}|${routeName}/files`);
    if (res.ok) return { valid: true, public: true };
    if (res.status === 403 || res.status === 401) return { valid: true, public: false };
  } catch (err) {
    console.warn('[report] Route validation API unreachable:', err);
  }
  return { valid: false, public: false };
}

export function formatRoute(dongleId: string, routeName: string, iteration?: string): string {
  return iteration ? `${dongleId}/${routeName}/${iteration}` : `${dongleId}/${routeName}`;
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
    console.error('Failed to fetch wiki suggestions:', err);
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
  if (title) {
    const raw = `${emoji} ${label} - ${title} (${ticketId})`;
    if (raw.length <= 100) return raw;
    const maxLen = 100 - emoji.length - label.length - ticketId.length - 6;
    const truncated = title.slice(0, Math.max(0, maxLen - 1)) + '…';
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
  dongleId: string,
  routeName: string,
  iteration: string | undefined,
  threadUrl: string,
  publicThreadTitle: string,
  routeNumber?: number,
): Promise<{ url: string; threadId: string } | null> {
  const routesForum = await getForum(guild, config.routesChannelId);
  if (!routesForum) return null;

  const routeStr = formatRoute(dongleId, routeName, iteration);
  const routeUrl = `https://connect.comma.ai/${dongleId}/${routeName}`;
  const routeLabel = routeNumber ? `**[ROUTE ${routeNumber}]** ` : '';

  // Check if a tracker thread already exists for this public post.
  const existing = await findRouteThread(routesForum, publicThreadTitle);
  if (existing) {
    const starter = await existing.fetchStarterMessage();
    if (starter) {
      const embed = starter.embeds[0];
      if (embed) {
        const updated = EmbedBuilder.from(embed);
        if (!embed.fields?.some((f: { value?: string }) => f.value?.includes(routeUrl))) {
          const existingField = updated.data.fields?.find(f => f.name === 'Additional Routes');
          if (existingField) {
            existingField.value += `\n${routeLabel}[${routeStr}](${routeUrl})`;
          } else {
            updated.addFields({ name: 'Additional Routes', value: `${routeLabel}[${routeStr}](${routeUrl})` });
          }
          await starter.edit({ embeds: [updated] });
        }
      }
    }
    return { url: existing.url, threadId: existing.id };
  }

  // Create new thread for this report's routes.
  const routeEmbed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(publicThreadTitle)
    .addFields(
      { name: 'Route', value: `${routeLabel}[${routeStr}](${routeUrl})` },
    )
    .setTimestamp();

  const routesThread = await routesForum.threads.create({
    name: publicThreadTitle,
    message: { embeds: [routeEmbed] },
  });

  // Add Original Post interlink.
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
      const routeStr = formatRoute(r.dongleId, r.routeName, r.iteration);
      const url = `https://connect.comma.ai/${r.dongleId}/${r.routeName}`;
      const base = `${r.routeNumber ? `**[ROUTE ${r.routeNumber}]** ` : ''}[${routeStr}](${url})`;
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
    console.warn('[report] Failed to add additional routes to tracker:', err);
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
    validRoutes: Array<ExtractedRoute & { valid: boolean; public: boolean }>;
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
    console.error('Failed to create thread:', err);
    await interaction.editReply({ content: 'Failed to create thread. Contact an admin.' });
    return;
  }

  const ticketId = String(parseInt(thread.id.slice(-7), 10));

  try {
    await thread.edit({ name: formatThreadTitle(params.emoji, params.label, generatedTitle, ticketId) });
  } catch (err) {
    console.error('Failed to rename thread:', err);
  }

  params.embed.setTitle(`${params.label} ${ticketId}`);

  // Route tracking: one tracker thread per report, additional routes append to it.
  const validRoutes = params.validRoutes.filter(r => r.valid);
  const publicRoutes = validRoutes.filter(r => r.public);
  if (publicRoutes.length > 0) {
    const primary = publicRoutes[0];
    const tracker = await createRouteTrackerThread(
      guild, config,
      primary.dongleId, primary.routeName, primary.iteration,
      thread.url, thread.name,
      primary.routeNumber,
    );
    if (tracker) {
      params.embed.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
      await addAdditionalRoutesToTracker(guild, tracker.threadId, publicRoutes.slice(1));
    }
  }

  // Confirm buttons for non-public routes.
  const nonPublic = validRoutes.filter(r => !r.public);
  if (params.primaryNonPublicRoute) {
    const btn = new ButtonBuilder()
      .setCustomId(encodeConfirmCustomId(ticketId, interaction.user.id, params.primaryNonPublicRoute.dongleId, params.primaryNonPublicRoute.routeName, params.primaryNonPublicRoute.iteration))
      .setLabel('Confirm Route')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📍');
    await thread.send({
      content: `<@${interaction.user.id}> Your route is valid but not yet public. Once you've made it public, click the button below to link it to this report.\n\nNeed help? Follow [these instructions](<https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting>).`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)],
    }).catch(err => console.error('Failed to send primary confirm button:', err));
  }

  const remainingNonPublic = params.primaryNonPublicRoute
    ? nonPublic.filter(r => r.dongleId !== params.primaryNonPublicRoute!.dongleId || r.routeName !== params.primaryNonPublicRoute!.routeName)
    : nonPublic;
  if (remainingNonPublic.length > 0) {
    const confirmRows = buildConfirmRows(remainingNonPublic, ticketId, interaction.user.id);
    await thread.send({
      content: `<@${interaction.user.id}> Some additional routes are not yet public. Once you've made them public, click the button below to link them to this report.`,
      components: confirmRows,
    }).catch(err => console.error('Failed to send additional confirm buttons:', err));
  }

  await addWikiSuggestions(params.embed, params.wikiQuery);
  const starter = await thread.fetchStarterMessage();
  if (starter) {
    const actionRow = buildActionRow(ticketId);
    await starter.edit({ embeds: [params.embed], components: [actionRow] }).catch(err => {
      console.error('Failed to edit starter message:', err);
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
    placeholder: 'Can you reproduce it? What is your ideal outcome?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Reproducibility & Intent').setTextInputComponent(reproIntentInput));

  const detailsInput = new TextInputBuilder({
    custom_id: 'details',
    style: TextInputStyle.Paragraph,
    placeholder: 'Optional extras...',
    required: false,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Additional Details').setTextInputComponent(detailsInput));

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
  const details = interaction.fields.getTextInputValue('details');

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

  const allRoutes: ExtractedRoute[] = [];
  const seenKeys = new Set<string>();

  const dedicatedKey = formatRoute(dedicatedRoute.dongleId, dedicatedRoute.routeName, dedicatedRoute.iteration);
  seenKeys.add(dedicatedKey);
  allRoutes.push(dedicatedRoute);

  // Scan all text fields for additional route IDs.
  const allText = [observed, expected, reproIntent, ...(details ? [details] : [])].join('\n');
  const textRoutes = extractRouteIds(allText);
  for (const r of textRoutes) {
    const key = formatRoute(r.dongleId, r.routeName, r.iteration);
    if (!seenKeys.has(key)) {
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

  const validRoutes = validatedRoutes.filter(r => r.valid);
  const numberedRoutes = validRoutes.map((r, i) => ({ ...r, routeNumber: i + 1 }));

  // Replace route IDs in public-facing text fields with numbered labels.
  const cleanObserved = replaceRouteIds(observed, numberedRoutes);
  const cleanExpected = replaceRouteIds(expected, numberedRoutes);
  const cleanReproIntent = replaceRouteIds(reproIntent, numberedRoutes);
  const cleanDetails = details ? replaceRouteIds(details, numberedRoutes) : null;

  const reportEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .addFields(
      { name: 'Observed Behavior', value: cleanObserved },
      { name: 'Expected Behavior', value: cleanExpected },
      { name: 'Reproducibility & Intent', value: cleanReproIntent },
    )
    .setTimestamp();

  if (cleanDetails) {
    reportEmbed.addFields({ name: 'Additional Details', value: cleanDetails });
  }

  const nonPublic = numberedRoutes.filter(r => !r.public);
  const primaryNonPublic = nonPublic.length > 0 && nonPublic[0].dongleId === numberedRoutes[0].dongleId ? nonPublic[0] : undefined;

  await submitReport(interaction, {
    embed: reportEmbed,
    titleSource: cleanObserved,
    wikiQuery: `${cleanObserved} ${cleanExpected} ${cleanReproIntent}`,
    validRoutes: numberedRoutes,
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
    console.warn('[report] Route check API unreachable on confirm:', err);
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
      guild, config, dongleId, routeName, iteration, thread.url, thread.name,
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

  // Scan and validate route IDs before stripping so we can number them.
  const routes = extractRouteIds(content);
  const validatedRoutes: Array<ExtractedRoute & { valid: boolean; public: boolean }> = [];
  for (const v of await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName)))) {
    validatedRoutes.push({ ...routes[validatedRoutes.length], ...v });
  }
  const numberedRoutes = validatedRoutes.filter(r => r.valid).map((r, i) => ({ ...r, routeNumber: i + 1 }));
  const cleanContent = replaceRouteIds(content, numberedRoutes);

  const embed = new EmbedBuilder()
    .setColor(type === 'feedback' ? COLORS.green : COLORS.blurple)
    .setTitle(label)
    .setDescription(cleanContent.length > 4096 ? cleanContent.slice(0, 4093) + '...' : cleanContent)
    .setTimestamp();

  await submitReport(interaction, {
    embed,
    titleSource: cleanContent,
    wikiQuery: cleanContent,
    validRoutes: numberedRoutes,
    label,
    emoji,
    tagNames: type === 'feedback' ? ['OPEN', 'FEEDBACK'] : ['OPEN', 'FEATURE REQUEST'],
  });
}
