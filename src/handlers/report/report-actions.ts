import { Discord, ButtonComponent, ModalComponent, SelectMenuComponent, Slash, SlashGroup, Guild } from 'discordx';
import type { CommandInteraction, StringSelectMenuInteraction, ActionRow, MessageActionRowComponent } from 'discord.js';
import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ThreadChannel,
  ComponentType,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { COLORS } from '../../util.js';
import { normalizeRouteInput, parseNormalizedRoute, validateRoute, stripRouteIds } from '../../comma.js';
import { getForum, addAdditionalRoutesToTracker, createRouteTrackerThread, TRACKER_FIELD_PREFIX } from './route-tracker.js';
import { resolveTagIds, buildActionRow } from './report-service.js';
import { createStore } from '../../store.js';

const log = createLogger('report-actions');

const assigneeTagStore = createStore<string>('assignee-tags');

async function getOrCreateAssigneeTag(forum: import('discord.js').ForumChannel, userId: string, username: string): Promise<string | null> {
  const cached = await assigneeTagStore.get(userId);
  if (cached) {
    if (forum.availableTags.some(t => t.id === cached)) return cached;
    await assigneeTagStore.delete(userId);
  }

  const tagName = `Assignee ${username}`;
  const existing = forum.availableTags.find(t => t.name === tagName);
  if (existing) {
    await assigneeTagStore.set(userId, existing.id);
    return existing.id;
  }

  try {
    const updated = await forum.setAvailableTags([
      ...forum.availableTags.map(t => ({ name: t.name, id: t.id, moderated: t.moderated, emoji: t.emoji ?? undefined })),
      { name: tagName },
    ]);
    const created = updated.availableTags.find(t => t.name === tagName);
    if (!created) return null;
    await assigneeTagStore.set(userId, created.id);
    return created.id;
  } catch (err) {
    log.warn({ err, tagName }, 'Failed to create assignee tag');
    return null;
  }
}

function hasStaffRole(member: GuildMember): boolean {
  return member.roles.cache.has(loadConfig().staffRole);
}

function buildStaffActionsReply(ticketId: string) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`staff_select_${ticketId}`)
    .setPlaceholder('Choose an action...')
    .addOptions(
      { label: 'Assign', value: 'assign', emoji: '👤', description: 'Assign yourself to this report' },
      { label: 'Merge', value: 'merge', emoji: '🔀', description: 'Merge this report into another thread' },
      { label: 'Close', value: 'close', emoji: '🔐', description: 'Close this report' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return { content: 'Select a staff action:', components: [row], flags: MessageFlags.Ephemeral } as const;
}

async function closeThread(thread: ThreadChannel, guild: import('discord.js').Guild): Promise<void> {
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

async function updateThreadButtons(thread: ThreadChannel): Promise<string | null> {
  const starter = await thread.fetchStarterMessage();
  if (!starter) return null;

  const embed = starter.embeds[0];
  if (!embed) return null;

  const titleMatch = embed.title?.match(/\((\d+)\)\s*$/);
  const ticketId = titleMatch?.[1] ?? String(parseInt(thread.id.slice(-7), 10));

  const actionRow = buildActionRow(ticketId);
  const edited = await starter.edit({ components: [actionRow] }).catch(err => { log.warn({ err }, 'Failed to update thread buttons'); return null; });
  if (!edited) return null;
  return ticketId;
}

@Discord()
export class BotReportActions {
  @ButtonComponent({ id: /^additional_report_/ })
  async additionalReport(interaction: ButtonInteraction) {
    const modal = new ModalBuilder()
      .setCustomId(`additional_report_modal_${interaction.id}`)
      .setTitle('Additional Report');

    const routeInput = new TextInputBuilder({
      custom_id: 'route_id',
      style: TextInputStyle.Short,
      placeholder: 'dongle_id/route_name or connect.comma.ai URL',
      required: true,
      max_length: 256,
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

  @ButtonComponent({ id: /^staff_actions_/ })
  async staffActions(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can use staff actions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = interaction.customId.replace('staff_actions_', '');
    await interaction.reply(buildStaffActionsReply(ticketId));
  }

  @SelectMenuComponent({ id: /^staff_select_/ })
  async staffSelect(interaction: StringSelectMenuInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can use staff actions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const [action] = interaction.values;
    if (!['assign', 'close', 'merge'].includes(action)) {
      await interaction.reply({ content: 'Invalid action.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'merge') {
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
      return;
    }

    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => {});

    if (action === 'assign') {
      await thread.members.add(interaction.user.id).catch(err => log.warn({ err }, 'Failed to add member to thread'));

      const assignStarter = await thread.fetchStarterMessage();
      if (assignStarter) {
        const assignEmbed = assignStarter.embeds[0];
        if (assignEmbed) {
          const assignUpdated = EmbedBuilder.from(assignEmbed);
          const assignIdx = assignEmbed.fields?.findIndex(f => f.name === '👤 Assigned to') ?? -1;
          const assignField = { name: '👤 Assigned to', value: `<@${interaction.user.id}>` };
          if (assignIdx >= 0) {
            assignUpdated.spliceFields(assignIdx, 1, assignField);
          } else {
            assignUpdated.addFields(assignField);
          }
          await assignStarter.edit({ embeds: [assignUpdated] }).catch(() => {});
        }
      }

      const assignConfig = loadConfig();
      const assignForum = await getForum(guild, assignConfig.forumChannelId);
      if (assignForum) {
        const tagIds: string[] = [];

        const assignedTagIds = resolveTagIds(assignForum, ['ASSIGNED']);
        tagIds.push(...assignedTagIds);

        const assigneeTagId = await getOrCreateAssigneeTag(assignForum, interaction.user.id, interaction.user.username);
        if (assigneeTagId) tagIds.push(assigneeTagId);

        if (tagIds.length > 0) {
          const assignExisting = thread.appliedTags as string[];
          const assignDeduped = assignExisting.filter(id => !tagIds.includes(id));
          await thread.setAppliedTags([...assignDeduped, ...tagIds]).catch(() => {});
        }
      }

      await interaction.followUp({ content: 'You have been assigned to this report.', flags: MessageFlags.Ephemeral });
    } else {
      const closeStarter = await thread.fetchStarterMessage();
      if (closeStarter) {
        const closeEmbed = closeStarter.embeds[0];
        if (closeEmbed) {
          const closeUpdated = EmbedBuilder.from(closeEmbed);
          closeUpdated.addFields({ name: '\u200B', value: `🔐 Closed by <@${interaction.user.id}>` });
          await closeStarter.edit({ embeds: [closeUpdated] }).catch(err => log.warn({ err }, 'Failed to edit starter'));
        }
      }

      await interaction.followUp({ content: 'Report closed.', flags: MessageFlags.Ephemeral });
      await closeThread(thread, guild);
    }
  }

  @ButtonComponent({ id: /^split_/ })
  async splitToThread(interaction: ButtonInteraction) {
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

    const additionalMsg = interaction.message;
    const additionalEmbed = additionalMsg.embeds?.[0];
    const rawDetails = additionalEmbed?.description?.trim() || '';

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

    await interaction.deferUpdate();

    const opTitle = opEmbed.title || thread.name;
    const splitEmbed = new EmbedBuilder()
      .setColor(COLORS.blurple)
      .setTitle(`${opTitle} (Split)`)
      .setDescription(rawDetails || 'Additional report')
      .addFields(
        { name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${trackerUrl})` },
        { name: '\u200B', value: `[Original Report \u2192](${starter.url})` },
      )
      .setTimestamp();

    const splitName = `✂️ Split - ${thread.name}`;
    const threadName = splitName.length > 100 ? splitName.slice(0, 97) + '\u2026' : splitName;

    const newThread = await forum.threads.create({
      name: threadName,
      message: { embeds: [splitEmbed] },
      appliedTags: thread.appliedTags as string[],
    });

    const splitTicketId = String(parseInt(newThread.id.slice(-7), 10));
    const splitStarter = await newThread.fetchStarterMessage();
    if (splitStarter) {
      const actionRow = buildActionRow(splitTicketId);
      await splitStarter.edit({ components: [actionRow] }).catch(err => log.warn({ err }, 'Failed to add action buttons'));
      await splitStarter.pin().catch(err => log.warn({ err }, 'Failed to pin split starter'));
    }

    const updatedEmbed = EmbedBuilder.from(opEmbed);
    const origPostIdx = opEmbed.fields?.findIndex(
      f => f.name === 'Original Post' || ('value' in f && (f.value as string)?.startsWith('[Original Post \u2192]')),
    ) ?? -1;
    const splitField = { name: '✂️ Split', value: `[${newThread.name}](${newThread.url})`, inline: true };
    if (origPostIdx >= 0) {
      updatedEmbed.spliceFields(origPostIdx, 0, splitField);
    } else {
      updatedEmbed.addFields(splitField);
    }
    await starter.edit({ embeds: [updatedEmbed] }).catch(err => log.warn({ err }, 'Failed to edit OP embed'));

    const updatedAdditionalEmbed = EmbedBuilder.from(additionalEmbed!);
    updatedAdditionalEmbed.addFields({ name: '✂️ Split to', value: `[${newThread.name}](${newThread.url})`, inline: true });
    await interaction.message.edit({ embeds: [updatedAdditionalEmbed], components: [] }).catch(err => log.warn({ err }, 'Failed to edit additional embed'));
  }

  @ModalComponent({ id: /^additional_report_modal_/ })
  async additionalReportModal(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const routeId = interaction.fields.getTextInputValue('route_id');
    const details = interaction.fields.getTextInputValue('details');

    log.info({
      userId: interaction.user.id,
      type: 'additional',
      route: routeId,
      details: details || null,
    }, 'Additional report submitted');

    let normalizedRoute: string;
    try {
      normalizedRoute = normalizeRouteInput(routeId);
    } catch (err) {
      await interaction.editReply({
        content: `Invalid route ID. ${err instanceof Error ? err.message : 'Use the format \`dongle_id/route_name\` or a connect.comma.ai URL.'}`,
      });
      return;
    }

    const parsed = parseNormalizedRoute(normalizedRoute);
    if (!parsed) {
      await interaction.editReply({
        content: `Invalid route ID. Use the format \`dongle_id/route_name\` (e.g. \`a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8\`) or a connect.comma.ai URL.`,
      });
      return;
    }
    const trimmedInput = routeId.trim();
    parsed.originalText = trimmedInput;
    parsed.isUrl = /^https:\/\/connect\.comma\.ai\//i.test(trimmedInput);

    const { dongleId, routeName } = parsed;
    const { valid, public: isPublic, rlogsAvailable } = await validateRoute(dongleId, routeName);
    if (!valid) {
      await interaction.editReply({ content: 'That route does not exist. Please check the Route ID and try again.' });
      return;
    }

    parsed.public = isPublic;
    parsed.rlogsAvailable = rlogsAvailable;

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

    const starter = await thread.fetchStarterMessage();
    if (!starter) {
      await interaction.editReply({ content: 'Could not find the report starter message.' });
      return;
    }

    const embed = starter.embeds[0];
    if (!embed) {
      await interaction.editReply({ content: 'Could not find the report embed.' });
      return;
    }

    let trackerUrl: string | undefined;
    let trackerThreadId: string | undefined;

    const trackerField = embed.fields?.find(f =>
      f.value?.startsWith(TRACKER_FIELD_PREFIX),
    );
    if (trackerField) {
      trackerUrl = trackerField.value?.match(/\]\((.+?)\)/)?.[1];
      if (trackerUrl) {
        trackerThreadId = trackerUrl.split('/').pop() ?? undefined;
      }
    }

    if (!trackerUrl || !trackerThreadId) {
      const config = loadConfig();
      const tracker = await createRouteTrackerThread(
        guild, config,
        undefined,
        thread.url, thread.name,
      );
      if (tracker) {
        trackerUrl = tracker.url;
        trackerThreadId = tracker.threadId;
        const updated = EmbedBuilder.from(embed);
        updated.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
        await starter.edit({ embeds: [updated] }).catch(err => log.warn({ err }, 'Failed to add tracker field to starter'));
      }
    }

    if (!trackerUrl || !trackerThreadId) {
      await interaction.editReply({ content: 'Failed to create a route tracker thread.' });
      return;
    }

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

    await addAdditionalRoutesToTracker(
      guild, trackerThreadId, [parsed],
      msg.url, `Additional Report #${additionalReportId}`,
    );

    await interaction.editReply({ content: `Route added to the tracker thread.${!isPublic ? ' The route is not yet public \u2014 make it public and use the Confirm button on the original report.' : ''}` });
  }

  @ModalComponent({ id: /^merge_modal_/ })
  async mergeModal(interaction: ModalSubmitInteraction) {
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

  @ButtonComponent({ id: /^assign_/ })
  @ButtonComponent({ id: /^close_/ })
  @ButtonComponent({ id: /^merge_/ })
  async legacyButton(interaction: ButtonInteraction) {
    await this.handleLegacyButton(interaction);
  }

  private async handleLegacyButton(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can use staff actions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = await updateThreadButtons(thread);
    if (!ticketId) {
      await interaction.reply({ content: 'Could not update thread buttons. Use `/update-report-thread` instead.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({
      content: `Thread updated to the new button format. (Ticket **${ticketId}**) Use **Staff Actions** to assign, merge, or close.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

const guildId = loadConfig().guildId;

@Discord()
@Guild(guildId)
@SlashGroup({
  description: 'Report thread management',
  name: 'report-actions',
  defaultMemberPermissions: PermissionFlagsBits.ManageThreads,
})
@SlashGroup('report-actions')
export class ReportCommands {
  @Slash({ description: 'Update the action buttons on this report thread to the latest format', name: 'update-thread' })
  async updateThread(interaction: CommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can update report threads.', flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isThread()) {
      await interaction.reply({ content: 'This command can only be used inside a report thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = await updateThreadButtons(channel);
    if (!ticketId) {
      await interaction.reply({ content: 'Could not update thread buttons. No report embed found.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: `Report thread buttons updated to the latest format. (Ticket **${ticketId}**)`, flags: MessageFlags.Ephemeral });
  }

  @Slash({ description: 'Open the staff actions menu for this report thread', name: 'staff-actions' })
  async staffActionsCommand(interaction: CommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can use staff actions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This command can only be used inside a report thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const starter = await thread.fetchStarterMessage();
    if (!starter) {
      await interaction.reply({ content: 'Could not find the report starter message.', flags: MessageFlags.Ephemeral });
      return;
    }

    const staffButton = starter.components
      .filter(row => row.type === ComponentType.ActionRow)
      .flatMap(row => (row as ActionRow<MessageActionRowComponent>).components)
      .find(c => c.type === ComponentType.Button && c.customId?.startsWith('staff_actions_'));

    if (!staffButton || staffButton.type !== ComponentType.Button) {
      await interaction.reply({ content: 'No Staff Actions button found in this thread\'s starter message.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = staffButton.customId!.replace('staff_actions_', '');
    await interaction.reply(buildStaffActionsReply(ticketId));
  }
}
