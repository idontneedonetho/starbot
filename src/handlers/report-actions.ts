import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ThreadChannel,
  GuildMember,
  Guild,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { loadConfig } from '../config.js';
import { COLORS } from '../util.js';
import { getForum, resolveTagIds, ROUTE_REGEX, validateRoute, addAdditionalRoutesToTracker, stripRouteIds, buildActionRow, TRACKER_FIELD_PREFIX } from './report.js';

function hasStaffRole(member: GuildMember): boolean {
  return member.roles.cache.has(loadConfig().staffRole);
}

async function closeThread(thread: ThreadChannel, guild: Guild): Promise<void> {
  const config = loadConfig();
  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) return;
  const closedTagIds = resolveTagIds(forum, ['CLOSED']);
  const keep = (thread.appliedTags as string[]).filter(id => {
    const tag = forum.availableTags.find(t => t.id === id);
    return tag && tag.name !== 'OPEN';
  });
  await thread.setAppliedTags([...keep, ...closedTagIds]).catch(() => {});
  await thread.setLocked(true).catch(() => {});
  await thread.setArchived(true).catch(() => {});
}



export async function handleAssign(interaction: ButtonInteraction) {
  if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
    await interaction.reply({ content: 'Only staff can assign reports.', flags: MessageFlags.Ephemeral });
    return;
  }

  const thread = interaction.channel;
  if (!thread?.isThread()) {
    await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  await thread.members.add(interaction.user.id).catch(err => console.warn('[assign] Failed to add member to thread:', err));

  const starter = await thread.fetchStarterMessage();
  if (starter) {
    const embed = starter.embeds[0];
    if (embed) {
      const updated = EmbedBuilder.from(embed);
      updated.addFields({ name: '👤 Assigned to', value: `<@${interaction.user.id}>` });
      await starter.edit({ embeds: [updated] }).catch(() => {});
    }
  }

  const config = loadConfig();
  const guild = interaction.guild;
  if (guild) {
    const forum = await getForum(guild, config.forumChannelId);
    if (forum) {
      const tagIds = resolveTagIds(forum, ['ASSIGNED']);
      if (tagIds.length > 0) {
        await thread.setAppliedTags([...(thread.appliedTags as string[]), ...tagIds]).catch(() => {});
      }
    }
  }

  await interaction.reply({ content: 'You have been assigned to this report.', flags: MessageFlags.Ephemeral });
}

export async function handleClose(interaction: ButtonInteraction) {
  if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
    await interaction.reply({ content: 'Only staff can close reports.', flags: MessageFlags.Ephemeral });
    return;
  }

  const thread = interaction.channel;
  if (!thread?.isThread()) {
    await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  const starter = await thread.fetchStarterMessage();
  if (starter) {
    const embed = starter.embeds[0];
    if (embed) {
      const updated = EmbedBuilder.from(embed);
      updated.addFields({ name: '\u200B', value: `🔒 Closed by <@${interaction.user.id}>` });
      await starter.edit({ embeds: [updated] }).catch(err => console.warn('[close] Failed to edit starter:', err));
    }
  }

  const guild = interaction.guild;
  if (guild) await closeThread(thread, guild);

  await interaction.reply({ content: 'Report closed.', flags: MessageFlags.Ephemeral });
}

export async function handleAdditionalReportButton(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId(`additional_report_modal_${interaction.id}`)
    .setTitle('Additional Report');

  const routeInput = new TextInputBuilder({
    custom_id: 'route_id',
    style: TextInputStyle.Short,
    placeholder: 'e.g. a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8',
    required: true,
    max_length: 128,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Route ID').setTextInputComponent(routeInput));

  const detailsInput = new TextInputBuilder({
    custom_id: 'details',
    style: TextInputStyle.Paragraph,
    placeholder: 'What additional info should we know?',
    required: false,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Details (optional)').setTextInputComponent(detailsInput));

  await interaction.showModal(modal);
}

export async function handleAdditionalReportSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const routeId = interaction.fields.getTextInputValue('route_id');
  const details = interaction.fields.getTextInputValue('details');

  const match = routeId.match(new RegExp(`^${ROUTE_REGEX.source}$`, 'i'));
  if (!match) {
    await interaction.editReply({
      content: `Invalid route ID. Use the format \`dongle_id/route_name\` (e.g. \`a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8\`).`,
    });
    return;
  }

  const [, dongleId, routeName, iteration] = match;
  const { valid, public: isPublic } = await validateRoute(dongleId, routeName);
  if (!valid) {
    await interaction.editReply({ content: 'That route does not exist. Please check the Route ID and try again.' });
    return;
  }

  const thread = interaction.channel;
  if (!thread?.isThread()) {
    await interaction.editReply({ content: 'This can only be used from a thread.' });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  // Find the existing route tracker thread from the starter embed.
  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await interaction.editReply({ content: 'Could not find the report starter message.' });
    return;
  }

  const embed = starter.embeds[0];
  if (!embed || !embed.fields) {
    await interaction.editReply({ content: 'Could not find the tracker link in the starter embed.' });
    return;
  }

  const trackerField = embed.fields.find(f =>
    f.value?.startsWith(TRACKER_FIELD_PREFIX),
  );
  if (!trackerField) {
    await interaction.editReply({ content: 'No route tracker thread found for this report.' });
    return;
  }
  const trackerUrl = trackerField.value?.match(/\]\((.+?)\)/)?.[1];
  if (!trackerUrl) {
    await interaction.editReply({ content: 'Could not parse the tracker link.' });
    return;
  }
  const trackerThreadId = trackerUrl.split('/').pop();
  if (!trackerThreadId) {
    await interaction.editReply({ content: 'Could not parse the tracker thread ID.' });
    return;
  }

  // Post the embed (no split button yet — need msg.id first).
  const msg = await thread.send({
    content: `<@${interaction.user.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setDescription(details ? stripRouteIds(details) : 'No additional info')
        .addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${trackerUrl})` })
        .setTimestamp(),
    ],
  });

  // Derive ID from message snowflake, then add the split button.
  const additionalReportId = String(parseInt(msg.id.slice(-7), 10));
  await msg.edit({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`split_${additionalReportId}`)
          .setLabel('✂️ Split to Thread')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  // Add to tracker with source attribution.
  if (trackerThreadId) {
    await addAdditionalRoutesToTracker(
      guild, trackerThreadId, [{ dongleId, routeName, iteration: iteration || undefined }],
      msg.url, `Additional Report #${additionalReportId}`,
    );
  }

  await interaction.editReply({ content: `Route added to the tracker thread.${!isPublic ? ' The route is not yet public — make it public and use the Confirm button on the original report.' : ''}` });
}

export async function handleMerge(interaction: ButtonInteraction) {
  if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
    await interaction.reply({ content: 'Only staff can merge reports.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`merge_modal_${interaction.id}`)
    .setTitle('Merge Report');

  const targetInput = new TextInputBuilder({
    custom_id: 'target_thread',
    style: TextInputStyle.Short,
    placeholder: 'Paste the target thread URL or ID',
    required: true,
    max_length: 200,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Target Thread').setTextInputComponent(targetInput));

  await interaction.showModal(modal);
}

export async function handleMergeSubmit(interaction: ModalSubmitInteraction) {
  if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
    await interaction.reply({ content: 'Only staff can merge reports.', flags: MessageFlags.Ephemeral });
    return;
  }

  const targetStr = interaction.fields.getTextInputValue('target_thread').trim();
  const targetId = targetStr.split('/').pop() || targetStr;

  const source = interaction.channel;
  if (!source?.isThread()) {
    await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
    return;
  }

  const targetChannel = await guild.channels.fetch(targetId);
  if (!targetChannel?.isThread()) {
    await interaction.reply({ content: 'Target channel is not a valid thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  const sourceStarter = await source.fetchStarterMessage();
  if (sourceStarter) {
    const sourceEmbed = sourceStarter.embeds[0];
    if (sourceEmbed) {
      const mergedEmbed = EmbedBuilder.from(sourceEmbed);
      mergedEmbed.addFields({ name: '\u200B', value: `Merged from [${source.name}](${source.url})` });
      await targetChannel.send({ embeds: [mergedEmbed] });
    }
  }

  await interaction.reply({ content: `Report merged into ${targetChannel}.`, flags: MessageFlags.Ephemeral });

  if (guild) await closeThread(source, guild);
}

export async function handleSplitToThread(interaction: ButtonInteraction) {
  if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
    await interaction.reply({ content: 'Only staff can split reports.', flags: MessageFlags.Ephemeral });
    return;
  }

  const thread = interaction.channel;
  if (!thread?.isThread()) {
    await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guild = interaction.guild;
  if (!guild) return;

  // Get the details text from the additional report message's embed.
  const additionalMsg = interaction.message;
  const additionalEmbed = additionalMsg.embeds?.[0];
  const rawDetails = additionalEmbed?.description?.trim() || '';

  // Find the OP's starter message and its embed.
  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await interaction.reply({ content: 'Could not find the report starter message.', flags: MessageFlags.Ephemeral });
    return;
  }

  const opEmbed = starter.embeds[0];
  if (!opEmbed) {
    await interaction.reply({ content: 'Could not find the report embed.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Extract route tracker URL from the OP's embed.
  const trackerField = opEmbed.fields?.find(f =>
    f.value?.startsWith(TRACKER_FIELD_PREFIX),
  );
  if (!trackerField) {
    await interaction.reply({ content: 'No route tracker thread found for this report.', flags: MessageFlags.Ephemeral });
    return;
  }
  const trackerUrl = trackerField.value?.match(/\]\((.+?)\)/)?.[1];
  if (!trackerUrl) {
    await interaction.reply({ content: 'Could not parse the tracker link.', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = loadConfig();
  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) {
    await interaction.reply({ content: 'Forum channel not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  // All validation passed — acknowledge before creating the thread.
  await interaction.deferUpdate();

  // Build the split embed: copy OP title with " (Split)", show details, link tracker.
  const opTitle = opEmbed.title || thread.name;
  const splitEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .setTitle(`${opTitle} (Split)`)
    .setDescription(rawDetails || 'Additional report')
    .addFields(
      { name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${trackerUrl})` },
      { name: '\u200B', value: `[Original Report →](${starter.url})` },
    )
    .setTimestamp();

  // Thread name: prepend "✂️ Split - " to the OP's thread name, truncate to 100 chars.
  const splitName = `✂️ Split - ${thread.name}`;
  const threadName = splitName.length > 100 ? splitName.slice(0, 97) + '…' : splitName;

  // Create the new thread in the forum, copying the OP's tags.
  const newThread = await forum.threads.create({
    name: threadName,
    message: { embeds: [splitEmbed] },
    appliedTags: thread.appliedTags as string[],
  });

  // Add action buttons to the split thread's starter message.
  const splitTicketId = String(parseInt(newThread.id.slice(-7), 10));
  const splitStarter = await newThread.fetchStarterMessage();
  if (splitStarter) {
    const actionRow = buildActionRow(splitTicketId);
    await splitStarter.edit({ components: [actionRow] }).catch(err => console.warn('[split] Failed to add action buttons:', err));
  }

  // Add an inline split field to the OP's starter embed (inserted before Original Post).
  const updatedEmbed = EmbedBuilder.from(opEmbed);
  const origPostIdx = opEmbed.fields?.findIndex(
    f => f.name === 'Original Post' || ('value' in f && (f.value as string)?.startsWith('[Original Post →]')),
  ) ?? -1;
  const splitField = { name: '✂️ Split', value: `[${newThread.name}](${newThread.url})`, inline: true };
  if (origPostIdx >= 0) {
    updatedEmbed.spliceFields(origPostIdx, 0, splitField);
  } else {
    updatedEmbed.addFields(splitField);
  }
  await starter.edit({ embeds: [updatedEmbed] }).catch(err => console.warn('[split] Failed to edit OP embed:', err));

  // Edit the additional report message to show the split link and remove the button.
  const updatedAdditionalEmbed = EmbedBuilder.from(additionalEmbed!);
  updatedAdditionalEmbed.addFields({ name: '✂️ Split to', value: `[${newThread.name}](${newThread.url})`, inline: true });
  await interaction.message.edit({ embeds: [updatedAdditionalEmbed], components: [] }).catch(err => console.warn('[split] Failed to edit additional embed:', err));
}
