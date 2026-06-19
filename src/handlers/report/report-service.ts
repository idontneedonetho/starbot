import type { ForumChannel, ModalSubmitInteraction, ButtonInteraction, ThreadChannel } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { getIndex } from '../../wiki/wiki.js';
import { searchWiki, formatWikiResults } from '../../wiki/searcher.js';
import { embedBatch } from '../../wiki/embedder.js';
import { dot } from '../../util.js';
import { getForum, createRouteTrackerThread, addAdditionalRoutesToTracker, encodeConfirmCustomId, buildConfirmRows, TRACKER_FIELD_PREFIX } from './route-tracker.js';
import { STATUS_EMOJI, isRateLimit } from './title-sync.js';
import type { ExtractedRoute, RouteValidation } from '../../comma.js';

const log = createLogger('report-service');

export function resolveTagIds(forum: ForumChannel, names: string[]): string[] {
  return names
    .map(name => forum.availableTags.find(t => t.name === name)?.id)
    .filter((id): id is string => id != null);
}

export function buildActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`additional_report_${ticketId}`)
      .setLabel('Additional Report')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📝'),
    new ButtonBuilder()
      .setCustomId(`staff_actions_${ticketId}`)
      .setLabel('Staff Actions')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🛠️'),
  );
}

export async function swapForumTags(
  thread: ThreadChannel,
  forum: ForumChannel,
  opts: { add?: string[]; remove?: string[] },
): Promise<void> {
  const removeNames = new Set(opts.remove ?? []);
  const keep = (thread.appliedTags as string[]).filter(id => {
    const tag = forum.availableTags.find(t => t.id === id);
    return !tag || !removeNames.has(tag.name);
  });
  const addIds = opts.add ? resolveTagIds(forum, opts.add) : [];
  await thread.setAppliedTags([...new Set([...keep, ...addIds])]).catch((err: unknown) => {
    // setAppliedTags hits PATCH /channels/:id — the route index.ts configures
    // rejectOnRateLimit on. A rate-limit rejection must propagate so close paths
    // can defer + retry via title-sync's worker (see closeThread). Other failures
    // (perms, etc.) are logged and swallowed so best-effort callers continue.
    if (isRateLimit(err)) throw err;
    log.warn({ err }, 'Failed to swap forum tags');
  });
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

export async function generateThreadTitle(input: string): Promise<string | null> {
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

// ticketId may be null at creation: the report is posted without the (id) suffix
// so it costs no rename, and title-sync folds the id in on the first status change.
export function formatThreadTitle(emoji: string, label: string, title: string | null, ticketId: string | null): string {
  const MAX = 100;
  const suffix = ticketId ? ` (${ticketId})` : '';
  if (title) {
    const raw = `${emoji} ${label} - ${title}${suffix}`;
    if (raw.length <= MAX) return raw;
    const overhead = `${emoji} ${label} - ${suffix}`.length;
    const maxTitleLen = MAX - overhead;
    if (maxTitleLen <= 1) return ticketId ? `${emoji} ${label} - ${ticketId}` : `${emoji} ${label}`;
    const truncated = title.slice(0, maxTitleLen - 1) + '\u2026';
    return `${emoji} ${label} - ${truncated}${suffix}`;
  }
  return ticketId ? `${emoji} ${label} - ${ticketId}` : `${emoji} ${label}`;
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

export async function submitReport(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  params: {
    embed: EmbedBuilder;
    titleSource: string;
    wikiQuery: string;
    dedicatedRoute?: ExtractedRoute & RouteValidation;
    additionalRoutes: Array<ExtractedRoute & RouteValidation>;
    label: string;
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
      // No ticket id in the title yet: the id is derived from the thread's own id,
      // which we only learn after creation. Renaming now would immediately spend
      // one of the 2-per-10-min title edits — and the very next status change often
      // needs it — so the id is left out and title-sync adds it on first transition.
      name: formatThreadTitle(STATUS_EMOJI['new'], params.label, generatedTitle, null),
      message: { content: `<@${interaction.user.id}>`, embeds: [params.embed] },
      appliedTags: tagIds,
    });
  } catch (err) {
    log.error({ err }, 'Failed to create thread');
    await interaction.editReply({ content: 'Failed to create thread. Contact an admin.' });
    return;
  }

  const ticketId = String(parseInt(thread.id.slice(-7), 10));

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
