import { Discord, ButtonComponent, ModalComponent, SelectMenuComponent, Slash, SlashGroup, Guild } from 'discordx';
import type { CommandInteraction, StringSelectMenuInteraction, ActionRow, MessageActionRowComponent } from 'discord.js';
import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ThreadChannel,
  type ForumChannel,
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
import { createStore } from '../../store.js';
import { COLORS, formatGitCommit, discordTimestamp, timeAgo, isStaleBuild } from '../../util.js';
import { normalizeRouteInput, parseNormalizedRoute, validateRoute, extractRouteIds, replaceRouteIds, fetchRouteMetadata } from '../../comma.js';
import { fetchCommitChoices, type CommitChoice } from '../../github.js';
import { getForum, addAdditionalRoutesToTracker, createRouteTrackerThread, routeNumberLabel, TRACKER_FIELD_PREFIX } from './route-tracker.js';
import { resolveTagIds, buildActionRow, swapForumTags } from './report-service.js';
import { setThreadStatusEmoji, setThreadStatusAndClose, setReportCloseHandler } from './title-sync.js';

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
      { label: 'Request User Testing', value: 'waituser', emoji: '🧪', description: 'Ask the user to test and report back' },
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
  await swapForumTags(thread, forum, { remove: ['OPEN', 'WAITING FOR DEV', 'WAITING FOR USER'], add: ['CLOSED'] });
  // No .catch here: a rate-limit rejection must propagate so title-sync's worker
  // can retry the close. setArchived runs last (archiving first would block the
  // lock edit). Skip edits already applied so each retry advances to the step
  // that actually failed instead of re-spending the rate-limit budget.
  if (!thread.locked) await thread.setLocked(true);
  if (!thread.archived) await thread.setArchived(true);
}

// title-sync's deferred worker and restart recovery finalize closes; give it a
// way to do so without an import cycle.
setReportCloseHandler(thread => closeThread(thread, thread.guild));

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

// Pending "newer commit" request between staff modal submit and commit pick. choices
// is snapshotted so the select handler doesn't refetch a list that may have rotated.
const waitCommitStore = createStore<{
  message: string; audience: string; submitterId: string; ticketId: string; threadId: string; choices: CommitChoice[];
}>('wait-commit-pending', { ttl: 15 * 60 * 1000 });

// Required commit per Ready message; lives as long as the report stays WAITING FOR USER.
const readyReqStore = createStore<{ requiredShort: string; requiredDate?: string }>(
  'wait-ready-req', { ttl: 30 * 24 * 60 * 60 * 1000 });

function buildAdditionalReportModal(customId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
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

  return modal;
}

// Split threads have no `By` field, so fall back to the linked Original Report's starter.
async function resolveSubmitterId(thread: ThreadChannel, guild: import('discord.js').Guild): Promise<string> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const fields = starter?.embeds[0]?.fields;
  const direct = fields?.find(f => f.name === 'By')?.value.match(/<@(\d+)>/)?.[1];
  if (direct) return direct;

  // Original Report URL: .../channels/<guild>/<channel>/<msg>
  const origUrl = fields?.find(f => /Original Report/.test(f.value ?? ''))?.value?.match(/\]\((.+?)\)/)?.[1];
  const origChannelId = origUrl?.split('/').slice(-2, -1)[0];
  if (origChannelId) {
    const origChannel = await guild.channels.fetch(origChannelId).catch(() => null);
    if (origChannel?.isThread()) {
      const origStarter = await origChannel.fetchStarterMessage().catch(() => null);
      const resolved = origStarter?.embeds[0]?.fields?.find(f => f.name === 'By')?.value.match(/<@(\d+)>/)?.[1];
      if (resolved) return resolved;
    }
  }
  return '';
}

async function notifyAssigneeReady(thread: ThreadChannel, respondingUserId: string, link?: string): Promise<void> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const assigneeId = starter?.embeds[0]?.fields?.find(f => f.name === '👤 Assigned to')?.value.match(/<@(\d+)>/)?.[1];
  if (!assigneeId || assigneeId === respondingUserId) return;
  await thread.send({
    content: `🔔 <@${assigneeId}> — <@${respondingUserId}> marked this **ready for another look**.${link ? ` [View their response](${link})` : ''}`,
    allowedMentions: { users: [assigneeId] },
  }).catch(err => log.warn({ err }, 'Failed to ping assignee on ready'));
}

interface WaitUserParams {
  mode: string;
  audience: string;
  message: string;
  submitterId: string;
  ticketId: string;
  requiredSha?: string;
  requiredShort?: string;
  branch?: string;
  requiredDate?: string;
}

async function finalizeWaitUser(thread: ThreadChannel, forum: ForumChannel, params: WaitUserParams): Promise<void> {
  // Best-effort (no deferred retry like closeThread): swallow even rate-limits.
  await swapForumTags(thread, forum, { remove: ['WAITING FOR DEV'], add: ['WAITING FOR USER'] })
    .catch(err => log.warn({ err }, 'Failed to swap forum tags for WAITING FOR USER'));
  await setThreadStatusEmoji(thread, 'waiting-for-user');

  const action = params.mode === 'anytime'
    ? "Click **Ready** below when you've tested and have feedback to share (no @pings please)."
    : "A **new route** is needed to reopen this report. Click **Ready** below to submit one once you've tested (no @pings please).";

  let required = '';
  if (params.mode === 'newer' && params.requiredSha) {
    const committed = params.requiredDate ? discordTimestamp(params.requiredDate) : null;
    required = `\n\nThe route must be on commit ${formatGitCommit(params.requiredSha, `github.com/${loadConfig().mainRepo}`)} (${params.branch}${committed ? `, committed ${committed}` : ''}) or newer.`;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle('🧪 Waiting for User')
    .setDescription(`${params.message ? params.message + '\n\n' : ''}${action}${required}`)
    .setTimestamp();

  // With no resolvable submitter, a 'sub' Ready and the Fixed button reject everyone —
  // fall back to an ungated Ready and drop Fixed.
  if (!params.submitterId) {
    log.warn({ threadId: thread.id, ticketId: params.ticketId }, 'No submitter resolved; posting ungated Ready without Fixed button');
  }
  const readyAudience = params.submitterId ? params.audience : 'any';
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ready_${params.mode}_${readyAudience}_${params.ticketId}_${params.submitterId}`)
      .setLabel('Ready')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
  ];
  if (params.submitterId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`fixed_${params.audience}_${params.ticketId}_${params.submitterId}`)
        .setLabel('My Issue is Fixed')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🎉'),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

  const sent = await thread.send({ embeds: [embed], components: [row] });
  if (params.mode === 'newer' && params.requiredSha) {
    await readyReqStore.set(sent.id, {
      requiredShort: params.requiredShort ?? params.requiredSha.slice(0, 7),
      requiredDate: params.requiredDate,
    });
  }
}

// Flip the "Waiting for User" message to a green completed state, dropping its
// buttons and noting what satisfied the request (feedback / submitted route).
async function completeReadyMessage(thread: ThreadChannel, msgId: string, note: string): Promise<void> {
  const msg = await thread.messages.fetch(msgId).catch(() => null);
  if (!msg) return;
  const embeds = msg.embeds[0]
    ? [EmbedBuilder.from(msg.embeds[0])
        .setColor(COLORS.green)
        .setTitle('✅ User Responded')
        .addFields({ name: '\u200B', value: note })]
    : [];
  await msg.edit({ embeds, components: [] }).catch(err => log.warn({ err }, 'Failed to complete Ready message'));
}

// Find the report's route tracker thread via the OP embed field, creating it
// (and recording the link on the OP) when missing.
async function ensureTrackerThread(thread: ThreadChannel, guild: import('discord.js').Guild): Promise<{ url: string; threadId: string } | null> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const embed = starter?.embeds[0];
  const trackerUrl = embed?.fields
    ?.find(f => f.value?.startsWith(TRACKER_FIELD_PREFIX))
    ?.value?.match(/\]\((.+?)\)/)?.[1];
  const trackerThreadId = trackerUrl?.split('/').pop();
  if (trackerUrl && trackerThreadId) return { url: trackerUrl, threadId: trackerThreadId };

  const tracker = await createRouteTrackerThread(guild, loadConfig(), undefined, thread.url, thread.name);
  if (tracker && starter && embed) {
    const updated = EmbedBuilder.from(embed);
    updated.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
    await starter.edit({ embeds: [updated] }).catch(err => log.warn({ err }, 'Failed to add tracker field to starter'));
  }
  return tracker;
}

function buildWaitUserModal(ticketId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`waituser_modal_${ticketId}`)
    .setTitle('Request User Testing');

  const messageInput = new TextInputBuilder({
    custom_id: 'message',
    style: TextInputStyle.Paragraph,
    placeholder: 'What should they test / which logs do you need?',
    required: false,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Message to the user (optional)').setTextInputComponent(messageInput));

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId('reopen_mode')
    .setMinValues(1)
    .addOptions(
      { label: 'Anytime', value: 'anytime', description: 'The user can respond right away', default: true },
      { label: 'With a new route', value: 'route', description: 'Responding requires submitting a new route' },
      { label: 'From a newer commit', value: 'newer', description: 'New route must be on a chosen commit or newer' },
    );
  modal.addLabelComponents(new LabelBuilder().setLabel('When may the user reopen?').setStringSelectMenuComponent(modeSelect));

  const audienceSelect = new StringSelectMenuBuilder()
    .setCustomId('respond_audience')
    .setMinValues(1)
    .addOptions(
      { label: 'Any Thread Participant', value: 'any', description: 'Anyone in the thread can respond', default: true },
      { label: 'Submitter', value: 'sub', description: 'Only the original submitter can respond' },
    );
  modal.addLabelComponents(new LabelBuilder().setLabel('Who may respond?').setStringSelectMenuComponent(audienceSelect));

  return modal;
}

@Discord()
export class BotReportActions {
  @ButtonComponent({ id: /^additional_report_/ })
  async additionalReport(interaction: ButtonInteraction) {
    await interaction.showModal(buildAdditionalReportModal(`additional_report_modal_${interaction.id}`));
  }

  @ModalComponent({ id: /^waituser_modal_/ })
  async handleWaitUserSubmit(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can request user testing.', flags: MessageFlags.Ephemeral });
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

    // Launched from the ephemeral Staff Actions select — acknowledge against that
    // message so the dropdown gets replaced instead of left dangling
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const ticketId = interaction.customId.replace('waituser_modal_', '');
    const message = interaction.fields.getTextInputValue('message');
    const modeValues = interaction.fields.getStringSelectValues('reopen_mode');
    const mode = modeValues.length > 0 ? modeValues[0] : 'anytime';
    const audienceValues = interaction.fields.getStringSelectValues('respond_audience');
    const audience = audienceValues.length > 0 ? audienceValues[0] : 'any';

    const submitterId = await resolveSubmitterId(thread, guild);

    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (!forum) {
      await interaction.editReply({ content: 'Forum channel not found. Contact an admin.', components: [] });
      return;
    }

    if (mode === 'newer') {
      const choices = await fetchCommitChoices();
      if (choices.length === 0) {
        await interaction.editReply({ content: "Couldn't reach GitHub to list commits. Try again in a moment.", components: [] });
        return;
      }
      await waitCommitStore.set(interaction.id, { message, audience, submitterId, ticketId, threadId: thread.id, choices });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`wcommit_${interaction.id}`)
        .setPlaceholder('Select the minimum required commit…')
        .addOptions(choices.map(c => {
          const label = `${c.branch} ${c.short} — ${c.subject}`;
          // plain text only — Discord doesn't render <t:…> markup in option descriptions
          const when = c.date ? c.date.replace('T', ' ').replace(/Z$/, ' UTC') : null;
          const ago = c.date ? timeAgo(c.date) : null;
          return {
            label: label.length > 100 ? label.slice(0, 99) + '…' : label,
            value: c.sha,
            description: when ? (ago ? `${when} — ${ago}` : when) : undefined,
          };
        }));
      await interaction.editReply({
        content: 'Pick the commit the new route must be on (or newer):',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      });
      return;
    }

    await finalizeWaitUser(thread, forum, { mode, audience, message, submitterId, ticketId });
    await interaction.editReply({ content: 'Report marked **WAITING FOR USER**.', components: [] });
  }

  @SelectMenuComponent({ id: /^wcommit_/ })
  async handleWaitCommitSelect(interaction: StringSelectMenuInteraction) {
    const token = interaction.customId.split('_')[1];
    const pending = await waitCommitStore.get(token);
    if (!pending) {
      await interaction.reply({ content: 'This request has expired. Use **Request User Testing** again.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can request user testing.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    let thread: ThreadChannel | null = interaction.channel?.isThread() ? interaction.channel : null;
    if (!thread) {
      const fetched = await guild.channels.fetch(pending.threadId).catch(() => null);
      thread = fetched?.isThread() ? fetched : null;
    }
    if (!thread) {
      await interaction.reply({ content: 'Could not resolve the report thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (!forum) {
      await interaction.reply({ content: 'Forum channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
      return;
    }

    const requiredSha = interaction.values[0];
    // ?. — entries persisted before the choices snapshot existed won't have it.
    const choice = pending.choices?.find(c => c.sha === requiredSha);
    const requiredShort = choice?.short ?? requiredSha.slice(0, 7);
    const branch = choice?.branch ?? 'unknown';
    const requiredDate = choice?.date;

    await finalizeWaitUser(thread, forum, {
      mode: 'newer',
      audience: pending.audience,
      message: pending.message,
      submitterId: pending.submitterId,
      ticketId: pending.ticketId,
      requiredSha,
      requiredShort,
      branch,
      requiredDate,
    });
    await waitCommitStore.delete(token);

    const committed = requiredDate ? discordTimestamp(requiredDate) : null;
    await interaction.update({
      content: `Report marked **WAITING FOR USER** — required commit \`${requiredShort}\` (${branch}${committed ? `, committed ${committed}` : ''}) or newer.`,
      components: [],
    });
  }

  @ButtonComponent({ id: /^ready_/ })
  async handleReadyButton(interaction: ButtonInteraction) {
    const [, mode, audience, ticketId, submitterId] = interaction.customId.split('_');

    const isStaff = interaction.member instanceof GuildMember && hasStaffRole(interaction.member);
    const allowed = isStaff || (audience === 'sub' ? interaction.user.id === submitterId : true);
    if (!allowed) {
      await interaction.reply({ content: 'Only the original submitter (or staff) can respond to this request.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (mode === 'anytime') {
      const modal = new ModalBuilder()
        .setCustomId(`readyfb_modal_${ticketId}_${interaction.message.id}`)
        .setTitle('Ready — Feedback');
      const feedbackInput = new TextInputBuilder({
        custom_id: 'feedback',
        style: TextInputStyle.Paragraph,
        placeholder: 'How did testing go? Anything to add?',
        required: false,
        max_length: 1024,
      });
      modal.addLabelComponents(new LabelBuilder().setLabel('Feedback (optional)').setTextInputComponent(feedbackInput));
      await interaction.showModal(modal);
      return;
    }

    await interaction.showModal(buildAdditionalReportModal(`additional_report_modal_ready_${ticketId}_${interaction.message.id}`));
  }

  @ModalComponent({ id: /^readyfb_modal_/ })
  async handleReadyFeedbackSubmit(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const msgId = interaction.customId.split('_')[3];

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

    const feedback = interaction.fields.getTextInputValue('feedback');
    let feedbackMsg: import('discord.js').Message | null = null;
    if (feedback) {
      const routes = extractRouteIds(feedback);
      const validations = await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName)));
      const numbered = routes.map((r, i) => ({ ...r, ...validations[i], routeNumber: i + 1 }));
      const cleanFeedback = replaceRouteIds(feedback, numbered, routeNumberLabel);
      const validRoutes = numbered.filter(r => r.valid);
      const tracker = validRoutes.length > 0 ? await ensureTrackerThread(thread, guild) : null;

      const feedbackEmbed = new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setTitle('💬 Feedback')
        .setDescription(cleanFeedback || 'No additional info')
        .setTimestamp();
      if (tracker) {
        feedbackEmbed.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
      }

      feedbackMsg = await thread.send({
        content: `<@${interaction.user.id}>`,
        embeds: [feedbackEmbed],
      }).catch(err => { log.warn({ err }, 'Failed to post ready feedback'); return null; });

      if (tracker) {
        await addAdditionalRoutesToTracker(
          guild, tracker.threadId, validRoutes,
          feedbackMsg?.url, feedbackMsg ? 'User Feedback' : undefined,
        );
      }
    }

    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (forum) {
      await swapForumTags(thread, forum, { remove: ['WAITING FOR USER'], add: ['WAITING FOR DEV'] })
        .catch(err => log.warn({ err }, 'Failed to swap forum tags for WAITING FOR DEV'));
    }
    await setThreadStatusEmoji(thread, 'waiting-for-dev');
    await completeReadyMessage(thread, msgId, feedbackMsg
      ? `Feedback submitted by <@${interaction.user.id}> — [view it](${feedbackMsg.url})`
      : `Marked ready by <@${interaction.user.id}>`);
    await notifyAssigneeReady(thread, interaction.user.id, feedbackMsg?.url);

    await interaction.editReply({ content: 'Thanks! The report is back to **WAITING FOR DEV**.' });
  }

  @ButtonComponent({ id: /^fixed_/ })
  async handleFixedButton(interaction: ButtonInteraction) {
    const submitterId = interaction.customId.split('_')[3];

    if (interaction.user.id !== submitterId) {
      await interaction.reply({ content: 'Only the original reporter can mark this issue as fixed.', flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`fixed_modal_${interaction.customId.split('_')[2]}_${interaction.message.id}`)
      .setTitle('Confirm — Issue Resolved?');
    const noteInput = new TextInputBuilder({
      custom_id: 'note',
      style: TextInputStyle.Paragraph,
      placeholder: 'Anything to add for the dev? (optional)',
      required: false,
      max_length: 1024,
    });
    modal.addLabelComponents(new LabelBuilder().setLabel('Additional feedback (optional)').setTextInputComponent(noteInput));
    await interaction.showModal(modal);
  }

  @ModalComponent({ id: /^fixed_modal_/ })
  async handleFixedSubmit(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const msgId = interaction.customId.split('_')[3];

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

    const note = interaction.fields.getTextInputValue('note');

    const resolvedEmbed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle('✅ Resolved by User')
      .setFooter({ text: `Closed by ${interaction.user.tag}` })
      .setTimestamp();
    if (note) resolvedEmbed.setDescription(note);
    await thread.send({ content: `<@${interaction.user.id}> marked this issue as fixed.`, embeds: [resolvedEmbed] }).catch(err => log.warn({ err }, 'Failed to post resolved embed'));

    const waitMsg = await thread.messages.fetch(msgId).catch(() => null);
    if (waitMsg) {
      const embeds = waitMsg.embeds[0]
        ? [EmbedBuilder.from(waitMsg.embeds[0])
            .setColor(COLORS.green)
            .setTitle('✅ Resolved by User')
            .addFields({ name: '\u200B', value: `Marked fixed by <@${interaction.user.id}>` })]
        : [];
      await waitMsg.edit({ embeds, components: [] }).catch(err => log.warn({ err }, 'Failed to complete Fixed message'));
    }

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) {
      const starterEmbed = starter.embeds[0];
      if (starterEmbed) {
        const updated = EmbedBuilder.from(starterEmbed);
        updated.addFields({ name: '\u200B', value: `🔐 Closed by <@${interaction.user.id}> (issue marked fixed)` });
        await starter.edit({ embeds: [updated] }).catch(err => log.warn({ err }, 'Failed to edit starter'));
      }
    }

    const resolvedDeferred = await setThreadStatusAndClose(thread, 'resolved');
    await interaction.editReply({ content: resolvedDeferred
      ? 'Thanks! This report is being **closed** as resolved — the title and close may take a moment if Discord is rate-limiting us.'
      : 'Thanks! This report has been **closed** as resolved.' });
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
    if (!['assign', 'close', 'merge', 'waituser'].includes(action)) {
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

    if (action === 'waituser') {
      const ticketId = interaction.customId.replace('staff_select_', '');
      await interaction.showModal(buildWaitUserModal(ticketId));
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

      await setThreadStatusEmoji(thread, 'waiting-for-dev');
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

      const closedDeferred = await setThreadStatusAndClose(thread, 'closed');
      await interaction.followUp({ content: closedDeferred
        ? 'Report closing — the title and close may take a moment if Discord is rate-limiting us.'
        : 'Report closed.', flags: MessageFlags.Ephemeral });
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

    // additional_report_modal_ready_<ticketId>_<msgId> reopens a WAITING FOR USER report
    const ready = interaction.customId.startsWith('additional_report_modal_ready_');
    const readyMsgId = ready ? interaction.customId.split('_')[5] : null;

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

    // Newer-build reopen gate: reject before anything is posted or tracked
    if (ready && readyMsgId) {
      const req = await readyReqStore.get(readyMsgId);
      if (req) {
        const meta = await fetchRouteMetadata(dongleId, routeName);
        if (!meta) {
          await interaction.editReply({ content: "Couldn't read this route's commit (make sure logs are uploaded). Nothing was submitted — the report is still **WAITING FOR USER**; try again once logs are up." });
          return;
        }
        if (isStaleBuild(meta.git_commit_date, req.requiredDate)) {
          const routeShort = meta.git_commit.slice(0, 7);
          const routeWhen = discordTimestamp(meta.git_commit_date);
          const reqWhen = req.requiredDate ? discordTimestamp(req.requiredDate) : null;
          await interaction.editReply({ content: `Route **rejected** — it's from an older build than required: route commit \`${routeShort}\`${routeWhen ? ` (committed ${routeWhen})` : ''} predates required \`${req.requiredShort}\`${reqWhen ? ` (committed ${reqWhen})` : ''}. Nothing was submitted — the report is still **WAITING FOR USER**; test on a newer build and submit a fresh route.` });
          return;
        }
      }
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

    const tracker = await ensureTrackerThread(thread, guild);
    if (!tracker) {
      await interaction.editReply({ content: 'Failed to create a route tracker thread.' });
      return;
    }

    // Routes mentioned in the details get the same treatment as report bodies:
    // validated, numbered [Route N] in the public text, and added to the tracker.
    const detailRoutes = details
      ? extractRouteIds(details).filter(r => (r.originalText ?? '').toLowerCase() !== trimmedInput.toLowerCase())
      : [];
    const detailValidations = await Promise.all(detailRoutes.map(r => validateRoute(r.dongleId, r.routeName)));
    const numberedDetailRoutes = detailRoutes.map((r, i) => ({ ...r, ...detailValidations[i], routeNumber: i + 1 }));
    const cleanDetails = details ? replaceRouteIds(details, [parsed, ...numberedDetailRoutes], routeNumberLabel) : '';

    const msg = await thread.send({
      content: `<@${interaction.user.id}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.blurple)
          .setDescription(cleanDetails || 'No additional info')
          .addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` })
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
      guild, tracker.threadId, [parsed, ...numberedDetailRoutes.filter(r => r.valid)],
      msg.url, `Additional Report #${additionalReportId}`,
    );

    let lifecycleNote = '';
    if (ready && readyMsgId) {
      const forum = await getForum(guild, loadConfig().forumChannelId);
      if (forum) {
        await swapForumTags(thread, forum, { remove: ['WAITING FOR USER'], add: ['WAITING FOR DEV'] })
          .catch(err => log.warn({ err }, 'Failed to swap forum tags for WAITING FOR DEV'));
      }
      await setThreadStatusEmoji(thread, 'waiting-for-dev');
      await completeReadyMessage(thread, readyMsgId, `A new route was submitted by <@${interaction.user.id}> — [Additional Report #${additionalReportId}](${msg.url})`);
      await readyReqStore.delete(readyMsgId);
      await notifyAssigneeReady(thread, interaction.user.id, msg.url);
      lifecycleNote = ' The report is now marked **WAITING FOR DEV**.';
    }

    await interaction.editReply({ content: `Route added to the tracker thread.${!isPublic ? ' The route is not yet public \u2014 make it public and use the Confirm button on the original report.' : ''}${lifecycleNote}` });
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

    if (guild) {
      const mergeDeferred = await setThreadStatusAndClose(source, 'closed');
      if (mergeDeferred) {
        await interaction.followUp({
          content: 'Closing the source thread — it may take a moment if Discord is rate-limiting us.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }
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
