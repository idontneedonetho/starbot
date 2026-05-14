import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  ModalBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
  ForumChannel,
  type Guild,
} from 'discord.js';
import { loadConfig } from '../config.js';
import { getMemberDisplayName } from './util.js';
import { getIndex } from '../wiki/wiki.js';
import { autoSearchWiki } from '../wiki/searcher.js';

const config = loadConfig();

function getForum(guild: Guild, id: string): ForumChannel | null {
  const channel = guild.channels.cache.get(id);
  return channel instanceof ForumChannel ? channel : null;
}

export async function handleReportButton(interaction: ButtonInteraction) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('report_type_select')
    .setPlaceholder('Select report type...')
    .addOptions(
      { label: 'Bug Report', value: 'Bug', emoji: '🐛', description: 'Report a navigation or system issue' },
      { label: 'General Feedback', value: 'Feedback', emoji: '💬', description: 'Share your thoughts' },
      { label: 'Feature Request', value: 'Feature Request', emoji: '✨', description: 'Request a new feature' },
    );

  await interaction.reply({
    content: 'What type of report would you like to submit?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleReportTypeSelect(interaction: StringSelectMenuInteraction) {
  const type = interaction.values[0];

  switch (type) {
    case 'Bug':
      await showBugModal(interaction);
      break;
    case 'Feedback':
      await showFeedbackModal(interaction, 'Feedback');
      break;
    case 'Feature Request':
      await showFeedbackModal(interaction, 'Feature Request');
      break;
  }
}

async function showBugModal(interaction: StringSelectMenuInteraction) {
  const modal = new ModalBuilder().setCustomId('bug_modal').setTitle('Submit Bug Report');

  const routeIdInput = new TextInputBuilder()
    .setCustomId('route_id')
    .setLabel('Route Name (Mod-Only)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8')
    .setRequired(true);

  const observedInput = new TextInputBuilder()
    .setCustomId('observed')
    .setLabel('Observed Behavior')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('What happened?')
    .setRequired(true);

  const expectedInput = new TextInputBuilder()
    .setCustomId('expected')
    .setLabel('Expected Behavior')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('What should have happened?')
    .setRequired(true);

  const reproIntentInput = new TextInputBuilder()
    .setCustomId('reproducibility_intent')
    .setLabel('Reproducibility & Intent')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Can you reproduce it? What is your ideal outcome?')
    .setRequired(true);

  const detailsInput = new TextInputBuilder()
    .setCustomId('details')
    .setLabel('Additional Details')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Optional extras...')
    .setRequired(false)
    .setMaxLength(60);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(routeIdInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(observedInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(expectedInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(reproIntentInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(detailsInput),
  );

  await interaction.showModal(modal);
}

async function showFeedbackModal(interaction: StringSelectMenuInteraction, type: string) {
  const modal = new ModalBuilder()
    .setCustomId(type === 'Feedback' ? 'feedback_modal' : 'feature_modal')
    .setTitle(type === 'Feedback' ? 'Submit Feedback' : 'Submit Feature Request');

  const input = new TextInputBuilder()
    .setCustomId('content')
    .setLabel('Your Thoughts')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(`Tell us about your ${type.toLowerCase()}...`)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

  await interaction.showModal(modal);
}

export async function handleBugSubmit(interaction: ModalSubmitInteraction) {
  const routeId = interaction.fields.getTextInputValue('route_id');
  const observed = interaction.fields.getTextInputValue('observed');
  const expected = interaction.fields.getTextInputValue('expected');
  const reproIntent = interaction.fields.getTextInputValue('reproducibility_intent');
  const details = interaction.fields.getTextInputValue('details');

  if (!/^[a-f0-9]{16}\/[a-zA-Z0-9_.-]+(?:\/\d+)?$/.test(routeId)) {
    await interaction.reply({
      content: 'Invalid route name. Use the format `dongle_id/route_signature` (e.g. `a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nickname = getMemberDisplayName(interaction);

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
    return;
  }

  const publicForum = getForum(guild, config.forumChannelId);
  if (!publicForum) {
    await interaction.reply({ content: 'Public forum channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reportEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Bug Report')
    .addFields(
      { name: 'Observed Behavior', value: observed },
      { name: 'Expected Behavior', value: expected },
      { name: 'Reproducibility & Intent', value: reproIntent },
    )
    .setTimestamp();

  if (details) {
    reportEmbed.addFields({ name: 'Additional Details', value: details });
  }

  const publicThread = await publicForum.threads.create({
    name: `🐛 Bug Report — ${nickname}`,
    message: { embeds: [reportEmbed] },
  });

  const routesForum = getForum(guild, config.routesChannelId);
  let routeTrackerUrl: string | null = null;
  let extraFieldsAdded = false;

  if (routesForum) {
    const routeUrl = `https://connect.comma.ai/${routeId}`;

    const routeEmbed = new EmbedBuilder()
      .setColor(0xf0b132)
      .setTitle('New Route Issue Flagged')
      .addFields(
        { name: 'User', value: nickname, inline: true },
        { name: 'Route', value: `[${routeId}](${routeUrl})`, inline: false },
      )
      .setTimestamp();

    const routesThread = await routesForum.threads.create({
      name: `Route Issue — ${nickname}`,
      message: { embeds: [routeEmbed] },
    });

    routeTrackerUrl = routesThread.url;

    // Cross-link: update routes thread → public thread
    const routesStarter = await routesThread.fetchStarterMessage();
    if (routesStarter) {
      routeEmbed.addFields(
        { name: '\u200B', value: `[Jump to Public Thread Discussion →](${publicThread.url})` },
      );
      await routesStarter.edit({ embeds: [routeEmbed] });
    }
  }

  // Wiki suggestions on public thread
  try {
    const wikiIndex = getIndex();
    if (wikiIndex) {
      const wikiQuery = `${observed} ${expected}`;
      const wikiResult = await autoSearchWiki(wikiIndex, wikiQuery);
      if (wikiResult) {
        reportEmbed.addFields({ name: '📖 Potentially Related Wiki Articles', value: wikiResult });
        extraFieldsAdded = true;
      }
    }
  } catch (err) {
    console.error('Failed to fetch wiki suggestions:', err);
  }

  // Append the route tracker link last so it stays at the bottom of the public embed.
  if (routeTrackerUrl) {
    reportEmbed.addFields({ name: '\u200B', value: `[Route Tracker (Mods Only)](${routeTrackerUrl})` });
    extraFieldsAdded = true;
  }

  if (extraFieldsAdded) {
    const starter = await publicThread.fetchStarterMessage();
    if (starter) await starter.edit({ embeds: [reportEmbed] });
  }

  await interaction.reply({
    content: `Bug report submitted! [View thread](${publicThread.url})`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleFeedbackSubmit(interaction: ModalSubmitInteraction, type: 'feedback' | 'feature') {
  const content = interaction.fields.getTextInputValue('content');

  const nickname = getMemberDisplayName(interaction);

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
    return;
  }

  const forumChannel = getForum(guild, config.forumChannelId);
  if (!forumChannel) {
    await interaction.reply({ content: 'Forum channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
    return;
  }

  const emoji = type === 'feedback' ? '💬' : '✨';
  const label = type === 'feedback' ? 'Feedback' : 'Feature Request';

  const embed = new EmbedBuilder()
    .setColor(type === 'feedback' ? 0x248046 : 0x5865f2)
    .setTitle(label)
    .setDescription(content)
    .setTimestamp();

  const thread = await forumChannel.threads.create({
    name: `${emoji} ${label} — ${nickname}`,
    message: { embeds: [embed] },
  });

  await interaction.reply({
    content: `${label} submitted! [View thread](${thread.url})`,
    flags: MessageFlags.Ephemeral,
  });
}
