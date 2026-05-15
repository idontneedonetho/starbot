import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  ModalBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
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
import type { BotConfig } from '../config.js';
import type { StoredData, PendingRouteData } from '../data.js';
import { saveData } from '../data.js';
import { getMemberDisplayName } from './util.js';
import { getIndex } from '../wiki/wiki.js';
import { autoSearchWiki, formatWikiResults } from '../wiki/searcher.js';

async function getForum(guild: Guild, id: string): Promise<ForumChannel | null> {
  const cached = guild.channels.cache.get(id);
  if (cached instanceof ForumChannel) return cached;
  try {
    const ch = await guild.channels.fetch(id);
    return ch instanceof ForumChannel ? ch : null;
  } catch {
    return null;
  }
}

export async function handleReportButton(_config: BotConfig, interaction: ButtonInteraction) {
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

export async function handleReportTypeSelect(config: BotConfig, interaction: StringSelectMenuInteraction) {
  const type = interaction.values[0];
  if (!type) {
    await interaction.reply({ content: 'Please select a report type.', flags: MessageFlags.Ephemeral });
    return;
  }

  switch (type) {
    case 'Bug':
      await showBugModal(config, interaction);
      break;
    case 'Feedback':
      await showFeedbackModal(config, interaction, 'Feedback');
      break;
    case 'Feature Request':
      await showFeedbackModal(config, interaction, 'Feature Request');
      break;
    default:
      await interaction.reply({ content: 'Unknown report type.', flags: MessageFlags.Ephemeral });
  }
}

async function showBugModal(_config: BotConfig, interaction: StringSelectMenuInteraction) {
  const modal = new ModalBuilder().setCustomId('bug_modal').setTitle('Submit Bug Report');

  const routeIdInput = new TextInputBuilder({
    custom_id: 'route_id',
    style: TextInputStyle.Short,
    placeholder: 'e.g. a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8',
    required: true,
    max_length: 128,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Route ID').setTextInputComponent(routeIdInput));

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

async function showFeedbackModal(_config: BotConfig, interaction: StringSelectMenuInteraction, type: string) {
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

interface PendingRoute extends PendingRouteData {}

export const pendingRoutes = new Map<number, PendingRoute>();

export async function handleBugSubmit(
  config: BotConfig,
  interaction: ModalSubmitInteraction,
  data: StoredData,
  getNextTicket: (d: StoredData) => { data: StoredData; ticketNumber: number },
) {
  const routeIdInput = interaction.fields.getTextInputValue('route_id');
  const observed = interaction.fields.getTextInputValue('observed');
  const expected = interaction.fields.getTextInputValue('expected');
  const reproIntent = interaction.fields.getTextInputValue('reproducibility_intent');
  const details = interaction.fields.getTextInputValue('details');

  const routeMatch = routeIdInput.match(/^([a-f0-9]{16})[\/|]([a-zA-Z0-9_.-]+)(?:\/([a-zA-Z0-9_.-]+))?$/);
  if (!routeMatch) {
    await interaction.reply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\nUse the format \`dongle_id/route_name\` (e.g. \`a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8\`).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, dongleId, routeName, iteration] = routeMatch;
  const connectRouteStr = iteration ? `${dongleId}/${routeName}/${iteration}` : `${dongleId}/${routeName}`;
  const routeUrl = `https://connect.comma.ai/${connectRouteStr}`;

  // Check route validity and publicity via comma.ai API.
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
  } catch {
    // API unreachable
  }

  if (!routeValid) {
    await interaction.reply({
      content: `The route you entered doesn't appear to exist:\n\`${routeIdInput}\`\n\nPlease double-check the Route ID and try again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { data: updatedData, ticketNumber } = getNextTicket(data);
  data.ticketCounter = updatedData.ticketCounter; // sync for later saves

  const nickname = getMemberDisplayName(interaction);

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
    return;
  }

  const publicForum = await getForum(guild, config.forumChannelId);
  if (!publicForum) {
    await interaction.reply({ content: 'Public forum channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reportEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Bug Report #${ticketNumber}`)
    .addFields(
      { name: 'Observed Behavior', value: observed },
      { name: 'Expected Behavior', value: expected },
      { name: 'Reproducibility & Intent', value: reproIntent },
    )
    .setTimestamp();

  if (details) {
    reportEmbed.addFields({ name: 'Additional Details', value: details });
  }

  let publicThread: Awaited<typeof publicForum.threads>['create'] extends (...args: infer A) => Promise<infer R> ? R : never;
  try {
    publicThread = await publicForum.threads.create({
      name: `🐛 Bug Report #${ticketNumber} — ${nickname}`,
      message: { embeds: [reportEmbed] },
    });
  } catch (err) {
    console.error('Failed to create public thread:', err);
    await interaction.reply({ content: 'Failed to create report thread. Contact an admin.', flags: MessageFlags.Ephemeral });
    return;
  }

  let routeTrackerUrl: string | null = null;

  if (routePublic) {
    const routesForum = await getForum(guild, config.routesChannelId);
    if (routesForum) {
      const routeEmbed = new EmbedBuilder()
        .setColor(0xf0b132)
        .setTitle(`Route Issue #${ticketNumber}`)
        .addFields(
          { name: 'User', value: nickname, inline: true },
          { name: 'Route (for Mods)', value: `[${dongleId}/${routeName}](${routeUrl})`, inline: false },
        )
        .setTimestamp();

      const routesThread = await routesForum.threads.create({
        name: `Route Issue #${ticketNumber} — ${nickname}`,
        message: { embeds: [routeEmbed] },
      });

      routeTrackerUrl = routesThread.url;

      reportEmbed.addFields(
        { name: '\u200B', value: `[Route Tracker →](${routeTrackerUrl})` },
      );

      const routesStarter = await routesThread.fetchStarterMessage();
      if (routesStarter) {
        routeEmbed.addFields(
          { name: '\u200B', value: `[Jump to Public Thread →](${publicThread.url})` },
        );
        await routesStarter.edit({ embeds: [routeEmbed] });
      }
    }
  } else {
    // Route is valid but not public — store for later confirmation.
    pendingRoutes.set(ticketNumber, { dongleId, routeName, iteration, userId: interaction.user.id });
    data.pendingRoutes[String(ticketNumber)] = { dongleId, routeName, iteration, userId: interaction.user.id };
    saveData(data);

    const confirmButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_route_${ticketNumber}`)
        .setLabel('Confirm Route')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📍'),
    );

    await publicThread.send({
      content: `<@${interaction.user.id}> Your route is valid but not yet public. Once you've made it public, click the button below to link it to this report.\n\nNeed help? Follow [these instructions](https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting).`,
      components: [confirmButton],
    });
  }

  // Wiki suggestions
  let wikiAdded = false;
  try {
    const wikiIndex = getIndex();
    if (wikiIndex) {
      const wikiQuery = `${observed} ${expected} ${reproIntent}`;
      const wikiResults = await autoSearchWiki(wikiIndex, wikiQuery);
      if (wikiResults.length > 0) {
        reportEmbed.addFields({ name: '📖 Potentially Related Wiki Articles', value: formatWikiResults(wikiResults) });
        wikiAdded = true;
      }
    }
  } catch (err) {
    console.error('Failed to fetch wiki suggestions:', err);
  }

  const routeAdded = routeTrackerUrl != null;

  if (wikiAdded || routeAdded) {
    const starter = await publicThread.fetchStarterMessage();
    if (starter) {
      await starter.edit({ embeds: [reportEmbed] }).catch(err => {
        console.error('Failed to edit starter message with wiki/route link:', err);
      });
    } else {
      console.error('Could not find starter message to edit with wiki/route link.');
    }
  }

  await interaction.reply({
    content: `Bug report **#${ticketNumber}** submitted! [View thread](${publicThread.url})`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleConfirmRoute(
  config: BotConfig,
  interaction: ButtonInteraction,
  data: StoredData,
) {
  const ticketNumber = parseInt(interaction.customId.replace('confirm_route_', ''), 10);
  if (isNaN(ticketNumber)) {
    await interaction.reply({ content: 'Invalid confirmation button.', flags: MessageFlags.Ephemeral });
    return;
  }

  const pending = pendingRoutes.get(ticketNumber);
  if (!pending) {
    await interaction.reply({ content: 'This route confirmation has expired or already been processed.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== pending.userId) {
    await interaction.reply({ content: 'Only the original reporter can confirm the route.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { dongleId, routeName, iteration } = pending;
  const connectRouteStr = iteration ? `${dongleId}/${routeName}/${iteration}` : `${dongleId}/${routeName}`;
  const routeUrl = `https://connect.comma.ai/${connectRouteStr}`;

  let nowPublic = false;
  try {
    const res = await fetch(`https://api.comma.ai/v1/route/${dongleId}|${routeName}/files`);
    nowPublic = res.ok;
  } catch {
    // API unreachable
  }

  const thread = interaction.channel;
  if (!thread || !thread.isThread()) {
    await interaction.reply({ content: 'This button can only be used from the report thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!nowPublic) {
    await interaction.reply({
      content: `Your route is still not public. Make sure it's accessible on [connect.comma.ai](${routeUrl}) and try again.\n\nFollow [these instructions](https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting) to make your route public.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

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
    const routesForum = await getForum(guild, config.routesChannelId);
    if (routesForum) {
      const nickname = getMemberDisplayName(interaction);
      const routeEmbed = new EmbedBuilder()
        .setColor(0xf0b132)
        .setTitle(`Route Issue #${ticketNumber}`)
        .addFields(
          { name: 'User', value: nickname, inline: true },
          { name: 'Route (for Mods)', value: `[${dongleId}/${routeName}](${routeUrl})`, inline: false },
        )
        .setTimestamp();

      const routesThread = await routesForum.threads.create({
        name: `Route Issue #${ticketNumber} — ${nickname}`,
        message: { embeds: [routeEmbed] },
      });

      routesThreadUrl = routesThread.url;

      const routesStarter = await routesThread.fetchStarterMessage();
      if (routesStarter) {
        routeEmbed.addFields(
          { name: '\u200B', value: `[Jump to Public Thread →](${thread.url})` },
        );
        await routesStarter.edit({ embeds: [routeEmbed] });
      }

      updated.addFields(
        { name: '\u200B', value: `[Route Tracker →](${routesThreadUrl})` },
      );
    }
  }

  await starter.edit({ embeds: [updated] });

  pendingRoutes.delete(ticketNumber);
  delete data.pendingRoutes[String(ticketNumber)];
  saveData(data);

  const content = `✅ Route confirmed and linked to **#${ticketNumber}**.${routesThreadUrl ? ` [View Route Tracker →](${routesThreadUrl})` : ''}`;
  await interaction.update({ content, components: [] });
}

export async function handleFeedbackSubmit(config: BotConfig, interaction: ModalSubmitInteraction, type: 'feedback' | 'feature') {
  const content = interaction.fields.getTextInputValue('content');

  const nickname = getMemberDisplayName(interaction);

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
    return;
  }

  const forumChannel = await getForum(guild, config.forumChannelId);
  if (!forumChannel) {
    await interaction.reply({ content: 'Forum channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
    return;
  }

  const emoji = type === 'feedback' ? '💬' : '✨';
  const label = type === 'feedback' ? 'Feedback' : 'Feature Request';

  const embed = new EmbedBuilder()
    .setColor(type === 'feedback' ? 0x248046 : 0x5865f2)
    .setTitle(label)
    .setDescription(content.length > 4096 ? content.slice(0, 4093) + '...' : content)
    .setTimestamp();

  let thread: Awaited<typeof forumChannel.threads>['create'] extends (...args: infer A) => Promise<infer R> ? R : never;
  try {
    thread = await forumChannel.threads.create({
      name: `${emoji} ${label} — ${nickname}`,
      message: { embeds: [embed] },
    });
  } catch (err) {
    console.error('Failed to create feedback thread:', err);
    await interaction.reply({ content: 'Failed to create thread. Contact an admin.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    content: `${label} submitted! [View thread](${thread.url})`,
    flags: MessageFlags.Ephemeral,
  });
}
