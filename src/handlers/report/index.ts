import { Discord, ButtonComponent, ModalComponent } from 'discordx';
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
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
} from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { COLORS } from '../../util.js';
import {
  parseRouteComponents,
  extractRouteIds,
  replaceRouteIds,
  validateRoute,
  type RouteComponents,
  type ExtractedRoute,
  type RouteValidation,
  type RlogCheckResult,
} from '../../comma.js';
import {
  routeNumberLabel,
  parseConfirmCustomId,
  handleRefreshRoutes,
  createRouteTrackerThread,
  addAdditionalRoutesToTracker,
  TRACKER_FIELD_PREFIX,
} from './route-tracker.js';
import {
  submitReport,
} from './report-service.js';

const log = createLogger('report');

function rlogFailureMessage(check: RlogCheckResult): string {
  if (check.mode === 'whole') {
    return 'All the logs must be uploaded. If you only have a few moments in the route to review, please use a route link / ID that is segmented.';
  }
  const segList = check.missing.join(', ');
  const noun = check.missing.length === 1 ? 'segment' : 'segments';
  return `The rlogs for ${noun} **${segList}** don't appear to be uploaded yet. Please upload the logs for ${noun} **${segList}** from your device, then check again.`;
}

interface BugReportInput {
  routeIdInput: string;
  observed: string;
  expected: string;
  reproIntent: string;
}

interface PendingBugReport extends BugReportInput {
  userId: string;
}

const PENDING_BUG_TTL_MS = 15 * 60 * 1000;
const pendingStore = createStore<PendingBugReport>('pending-bug-reports', { ttl: PENDING_BUG_TTL_MS });

@Discord()
export class BotReport {
  @ButtonComponent({ id: 'report_bug' })
  async bug(interaction: ButtonInteraction) {
    await showBugModal(interaction);
  }

  @ButtonComponent({ id: 'report_feedback' })
  async feedback(interaction: ButtonInteraction) {
    await showFeedbackModal(interaction, 'Feedback');
  }

  @ButtonComponent({ id: 'report_feature' })
  async feature(interaction: ButtonInteraction) {
    await showFeedbackModal(interaction, 'Feature Request');
  }

  @ButtonComponent({ id: /^cr_/ })
  async confirmRoute(interaction: ButtonInteraction) {
    await handleConfirmRoute(interaction);
  }

  @ButtonComponent({ id: /^rlogchk_/ })
  async rlogRecheck(interaction: ButtonInteraction) {
    await handleRlogGateButton(interaction, false);
  }

  @ButtonComponent({ id: /^rlogfrc_/ })
  async rlogForceProceed(interaction: ButtonInteraction) {
    await handleRlogGateButton(interaction, true);
  }

  @ButtonComponent({ id: 'refresh_routes' })
  async refreshRoutes(interaction: ButtonInteraction) {
    await handleRefreshRoutes(interaction);
  }

  @ModalComponent({ id: 'bug_modal' })
  async bugModal(interaction: ModalSubmitInteraction) {
    await handleBugSubmit(interaction);
  }

  @ModalComponent({ id: 'feedback_modal' })
  async feedbackModal(interaction: ModalSubmitInteraction) {
    await handleFeedbackSubmit(interaction, 'feedback');
  }

  @ModalComponent({ id: 'feature_modal' })
  async featureModal(interaction: ModalSubmitInteraction) {
    await handleFeedbackSubmit(interaction, 'feature');
  }
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

async function handleBugSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const input: BugReportInput = {
    routeIdInput: interaction.fields.getTextInputValue('route_id'),
    observed: interaction.fields.getTextInputValue('observed'),
    expected: interaction.fields.getTextInputValue('expected'),
    reproIntent: interaction.fields.getTextInputValue('reproducibility_intent'),
  };

  log.info({
    userId: interaction.user.id,
    type: 'bug',
    route: input.routeIdInput,
    observed: input.observed,
    expected: input.expected,
    reproIntent: input.reproIntent,
  }, 'Bug report submitted');

  await processBugReport(interaction, input, false);
}

async function processBugReport(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  input: BugReportInput,
  force: boolean,
): Promise<void> {
  const { routeIdInput, observed, expected, reproIntent } = input;

  let components: RouteComponents;
  try {
    components = parseRouteComponents(routeIdInput);
  } catch (err) {
    await interaction.editReply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\n${err instanceof Error ? err.message : 'Use the format `dongle_id/route_name` or a connect.comma.ai URL.'}`,
    });
    return;
  }

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

  const validations = await Promise.all(
    allRoutes.map((r, i) =>
      i === 0
        ? validateRoute(r.dongleId, r.routeName, components.startSegment, components.endSegment)
        : validateRoute(r.dongleId, r.routeName),
    ),
  );
  const validatedRoutes = allRoutes.map((r, i) => ({ ...r, ...validations[i] }));
  const dedicatedValidated = validatedRoutes[0];

  if (!dedicatedValidated.valid) {
    await interaction.editReply({
      content: `The route you entered doesn't appear to exist:\n\`${routeIdInput}\`\n\nPlease double-check the Route ID and try again.`,
    });
    return;
  }

  if (!force && dedicatedValidated.public && dedicatedValidated.rlogCheck && !dedicatedValidated.rlogsAvailable) {
    const token = interaction.id;
    await pendingStore.set(token, { ...input, userId: interaction.user.id });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rlogchk_${token}`)
        .setLabel('Check Again')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('\uD83D\uDD04'),
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

  const numberedAdditional = validatedRoutes.slice(1).map((r, i) => ({ ...r, routeNumber: i + 1 }));

  const replacementRoutes: ExtractedRoute[] = [dedicatedValidated, ...numberedAdditional];
  const cleanObserved = replaceRouteIds(observed, replacementRoutes, routeNumberLabel);
  const cleanExpected = replaceRouteIds(expected, replacementRoutes, routeNumberLabel);
  const cleanReproIntent = replaceRouteIds(reproIntent, replacementRoutes, routeNumberLabel);

  const reportEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .addFields(
      { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
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
    tagNames: ['OPEN', 'BUG', 'WAITING FOR DEV'],
    primaryNonPublicRoute: primaryNonPublic,
    footerNote: ' with ticket ID / wiki / route link',
  });
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
  await interaction.deferUpdate();
  await processBugReport(interaction, pending, force);
}

async function handleConfirmRoute(interaction: ButtonInteraction) {
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

  const guild = interaction.guild;
  let routesThreadUrl: string | null = null;
  if (guild) {
    const route = { dongleId, routeName, iteration, public: true, rlogsAvailable: confirmCheck.rlogsAvailable };
    const existingUrl = embed.fields?.find(f => f.value?.startsWith(TRACKER_FIELD_PREFIX))?.value?.match(/\]\((.+?)\)/)?.[1];
    const existingId = existingUrl?.split('/').pop();
    if (existingUrl && existingId) {
      await addAdditionalRoutesToTracker(guild, existingId, [route]);
      routesThreadUrl = existingUrl;
    } else {
      const result = await createRouteTrackerThread(guild, config, route, thread.url, thread.name);
      if (result) {
        routesThreadUrl = result.url;
        updated.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${result.url})` });
      }
    }
  }

  await starter.edit({ embeds: [updated] });

  const content = `\u2705 Route confirmed and linked to **${ticketId}**.${routesThreadUrl ? ` [Mods Route Tracker \u2192](${routesThreadUrl})` : ''}`;
  await interaction.update({ content, components: [] });
}

async function handleFeedbackSubmit(interaction: ModalSubmitInteraction, type: 'feedback' | 'feature') {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const content = interaction.fields.getTextInputValue('content');

  const label = type === 'feedback' ? 'Feedback' : 'Feature Request';

  log.info({
    userId: interaction.user.id,
    type,
    content,
  }, `${label} submitted`);

  const routes = extractRouteIds(content);
  const validatedRoutes: Array<ExtractedRoute & RouteValidation> = [];
  for (const v of await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName)))) {
    validatedRoutes.push({ ...routes[validatedRoutes.length], ...v });
  }
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
    tagNames: type === 'feedback' ? ['OPEN', 'FEEDBACK', 'WAITING FOR DEV'] : ['OPEN', 'FEATURE REQUEST', 'WAITING FOR DEV'],
  });
}
