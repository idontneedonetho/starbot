import crypto from 'crypto';
import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
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
  type Guild,
} from 'discord.js';
import { loadConfig } from '../config.js';
import { getIndex } from '../wiki/wiki.js';
import { embedBatch } from '../wiki/embedder.js';
import { autoSearchWiki, formatWikiResults } from '../wiki/searcher.js';

interface ParsedConfirmRoute {
  ticketId: string;
  userId: string;
  dongleId: string;
  routeName: string;
  iteration?: string;
  createdAt: number;
}

const pendingRoutes = new Map<string, ParsedConfirmRoute>();

function encodeConfirmCustomId(ticketId: string, userId: string, dongleId: string, routeName: string, iteration?: string): string {
  const token = crypto.randomBytes(4).toString('hex');
  pendingRoutes.set(token, { ticketId, userId, dongleId, routeName, iteration, createdAt: Date.now() });
  return `confirm_route_${token}`;
}

function parseConfirmCustomId(customId: string): ParsedConfirmRoute | null {
  const token = customId.replace('confirm_route_', '');
  const data = pendingRoutes.get(token);
  if (data) pendingRoutes.delete(token);
  return data ?? null;
}

// Purge pending routes older than 24 hours every 30 minutes.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [token, data] of pendingRoutes) {
    if (data.createdAt < cutoff) pendingRoutes.delete(token);
  }
}, 30 * 60 * 1000).unref();

async function getForum(guild: Guild, id: string): Promise<ForumChannel | null> {
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

const COLORS = {
  blurple: 0x5865f2,
  amber: 0xf0b132,
  green: 0x248046,
} as const;

async function createRouteTrackerThread(
  guild: Guild,
  config: ReturnType<typeof loadConfig>,
  ticketId: string,
  userId: string,
  title: string | null,
  dongleId: string,
  routeName: string,
  routeUrl: string,
  threadUrl: string,
): Promise<string | null> {
  const routesForum = await getForum(guild, config.routesChannelId);
  if (!routesForum) return null;

  const routeEmbed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(`Route Issue ${ticketId}`)
    .addFields(
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'Route', value: `[${dongleId}/${routeName}](${routeUrl})`, inline: false },
    )
    .setTimestamp();

  const routesThread = await routesForum.threads.create({
    name: title ? `Route Issue - ${title} (${ticketId})` : `Route Issue - ${ticketId}`,
    message: { embeds: [routeEmbed] },
  });

  const routesStarter = await routesThread.fetchStarterMessage();
  if (routesStarter) {
    routeEmbed.addFields(
      { name: '\u200B', value: `[Jump to Public Thread →](${threadUrl})` },
    );
    await routesStarter.edit({ embeds: [routeEmbed] });
  }

  return routesThread.url;
}

function dot(a: number[], b: number[]): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i] * b[i];
  return result;
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
    placeholder: 'e.g. a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8',
    required: true,
    max_length: 128,
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
  const config = loadConfig();

  const routeIdInput = interaction.fields.getTextInputValue('route_id');
  const observed = interaction.fields.getTextInputValue('observed');
  const expected = interaction.fields.getTextInputValue('expected');
  const reproIntent = interaction.fields.getTextInputValue('reproducibility_intent');
  const details = interaction.fields.getTextInputValue('details');

  const routeMatch = routeIdInput.match(/^([a-f0-9]{16})[\/|]([a-zA-Z0-9_.-]+)(?:\/([a-zA-Z0-9_.-]+))?$/);
  if (!routeMatch) {
    await interaction.editReply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\nUse the format \`dongle_id/route_name\` (e.g. \`a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8\`).`,
    });
    return;
  }

  const [, dongleId, routeName, iteration] = routeMatch;
  const connectRouteStr = iteration ? `${dongleId}/${routeName}/${iteration}` : `${dongleId}/${routeName}`;
  const routeUrl = `https://connect.comma.ai/${connectRouteStr}`;

  let routeValid = false;
  let routePublic = false;
  try {
    const res = await fetch(`https://api.comma.ai/v1/route/${dongleId}|${routeName}/files`);
    if (res.ok) {
      routeValid = true;
      routePublic = true;
    } else if (res.status === 403 || res.status === 401) {
      routeValid = true;
    }
  } catch (err) {
    console.warn('[report] Route validation API unreachable:', err);
  }

  if (!routeValid) {
    await interaction.editReply({
      content: `The route you entered doesn't appear to exist:\n\`${routeIdInput}\`\n\nPlease double-check the Route ID and try again.`,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  const publicForum = await getForum(guild, config.forumChannelId);
  if (!publicForum) {
    await interaction.editReply({ content: 'Public forum channel not found. Contact an admin.' });
    return;
  }

  const reportEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .addFields(
      { name: 'Observed Behavior', value: observed },
      { name: 'Expected Behavior', value: expected },
      { name: 'Reproducibility & Intent', value: reproIntent },
    )
    .setTimestamp();

  if (details) {
    reportEmbed.addFields({ name: 'Additional Details', value: details });
  }

  const bugTitle = await generateThreadTitle(observed).catch(() => null);

  let publicThread: Awaited<ReturnType<typeof publicForum.threads.create>>;
  try {
    publicThread = await publicForum.threads.create({
      name: bugTitle ? `🐛 Bug Report - ${bugTitle}` : '🐛 Bug Report',
      message: { content: `<@${interaction.user.id}>`, embeds: [reportEmbed] },
    });
  } catch (err) {
    console.error('Failed to create public thread:', err);
    await interaction.editReply({ content: 'Failed to create report thread. Contact an admin.' });
    return;
  }

  const ticketId = String(parseInt(publicThread.id.slice(-5), 10));
  await publicThread.edit({ name: bugTitle ? `🐛 Bug Report - ${bugTitle} (${ticketId})` : `🐛 Bug Report - ${ticketId}` });
  reportEmbed.setTitle(`Bug Report ${ticketId}`);

  let routeTrackerUrl: string | null = null;

  if (routePublic) {
    routeTrackerUrl = await createRouteTrackerThread(
      guild, config, ticketId, interaction.user.id, bugTitle, dongleId, routeName, routeUrl, publicThread.url,
    );
    if (routeTrackerUrl) {
      reportEmbed.addFields(
        { name: '\u200B', value: `[Mods route Tracker →](${routeTrackerUrl})` },
      );
    }
  } else {
    // Route is valid but not public — encode data in the confirm button itself.
    const confirmButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeConfirmCustomId(ticketId, interaction.user.id, dongleId, routeName, iteration))
        .setLabel('Confirm Route')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📍'),
    );

    await publicThread.send({
      content: `<@${interaction.user.id}> Your route is valid but not yet public. Once you've made it public, click the button below to link it to this report.\n\nNeed help? Follow [these instructions](<https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting>).`,
      components: [confirmButton],
    });
  }

  // Wiki suggestions
  try {
    const wikiIndex = getIndex();
    if (wikiIndex) {
      const wikiQuery = `${observed} ${expected} ${reproIntent}`;
      const wikiResults = await autoSearchWiki(wikiIndex, wikiQuery);
      if (wikiResults.length > 0) {
        reportEmbed.addFields({ name: '📖 Potentially Related Wiki Articles', value: formatWikiResults(wikiResults) });
      }
    }
  } catch (err) {
    console.error('Failed to fetch wiki suggestions:', err);
  }

  const starter = await publicThread.fetchStarterMessage();
  if (starter) {
    await starter.edit({ embeds: [reportEmbed] }).catch(err => {
      console.error('Failed to edit starter message with ticket ID / wiki / route link:', err);
    });
  } else {
    console.error('Could not find starter message to edit.');
  }

  await interaction.editReply({
    content: `Bug report **${ticketId}** submitted! [View thread](${publicThread.url})`,
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

  const connectRouteStr = iteration ? `${dongleId}/${routeName}/${iteration}` : `${dongleId}/${routeName}`;
  const routeUrl = `https://connect.comma.ai/${connectRouteStr}`;

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
    routesThreadUrl = await createRouteTrackerThread(
      guild, config, ticketId, interaction.user.id, null, dongleId, routeName, routeUrl, thread.url,
    );
    if (routesThreadUrl) {
      updated.addFields(
        { name: '\u200B', value: `[Mods route Tracker →](${routesThreadUrl})` },
      );
    }
  }

  await starter.edit({ embeds: [updated] });

  const content = `✅ Route confirmed and linked to **${ticketId}**.${routesThreadUrl ? ` [Mods route Tracker →](${routesThreadUrl})` : ''}`;
  await interaction.update({ content, components: [] });
}

export async function handleFeedbackSubmit(interaction: ModalSubmitInteraction, type: 'feedback' | 'feature') {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = loadConfig();

  const content = interaction.fields.getTextInputValue('content');

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  const forumChannel = await getForum(guild, config.forumChannelId);
  if (!forumChannel) {
    await interaction.editReply({ content: 'Forum channel not found. Contact an admin.' });
    return;
  }

  const emoji = type === 'feedback' ? '💬' : '✨';
  const label = type === 'feedback' ? 'Feedback' : 'Feature Request';

  const embed = new EmbedBuilder()
    .setColor(type === 'feedback' ? COLORS.green : COLORS.blurple)
    .setTitle(label)
    .setDescription(content.length > 4096 ? content.slice(0, 4093) + '...' : content)
    .setTimestamp();

  const feedbackTitle = await generateThreadTitle(content).catch(() => null);

  let thread: Awaited<ReturnType<typeof forumChannel.threads.create>>;
  try {
    thread = await forumChannel.threads.create({
      name: feedbackTitle ? `${emoji} ${label} - ${feedbackTitle}` : `${emoji} ${label}`,
      message: { content: `<@${interaction.user.id}>`, embeds: [embed] },
    });
  } catch (err) {
    console.error('Failed to create feedback thread:', err);
    await interaction.editReply({ content: 'Failed to create thread. Contact an admin.' });
    return;
  }

  await interaction.editReply({
    content: `${label} submitted! [View thread](${thread.url})`,
  });
}
