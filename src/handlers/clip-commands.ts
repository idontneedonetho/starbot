import {
  Discord,
  Slash,
  SlashGroup,
  SlashOption,
  SlashChoice,
  ModalComponent,
  Guild,
  ButtonComponent,
  SelectMenuComponent,
} from 'discordx';
import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  type ModalSubmitInteraction,
  type ButtonInteraction,
  type AnySelectMenuInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
} from 'discord.js';
import {
  handleClipRequest,
  getCachedClip,
  deleteCachedClip,
  RENDER_TYPE_MAP,
  RENDER_TYPES_WITH_ANONYMIZATION,
  ANONYMIZATION_PROFILES,
  PASSENGER_REDACTION_STYLES,
  VALID_RENDER_TYPES,
  type ClipJobInput,
} from './clip.js';
import { loadConfig } from '../config.js';
import { COLORS } from '../util.js';

const MODAL_ID = 'clip_form';
const guildId = loadConfig().guildId;

const pendingForm = new Map<string, { input: ClipJobInput; createdAt: number }>();

function setPendingForm(userId: string, input: ClipJobInput) {
  const now = Date.now();
  for (const [k, v] of pendingForm) {
    if (now - v.createdAt > 5 * 60 * 1000) pendingForm.delete(k);
  }
  pendingForm.set(userId, { input, createdAt: now });
}

function getPendingForm(userId: string): ClipJobInput | undefined {
  const entry = pendingForm.get(userId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
    pendingForm.delete(userId);
    return undefined;
  }
  return entry.input;
}

@Discord()
@Guild(guildId)
@SlashGroup({ description: 'Create replay clips from comma connect routes', name: 'clip' })
@SlashGroup('clip')
export class ClipCommands {

  @Slash({ description: 'Open a form with all clip options', name: 'form' })
  async form(interaction: CommandInteraction) {
    const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Create Clip');

    const urlInput = new TextInputBuilder({
      custom_id: 'clip_url',
      style: TextInputStyle.Short,
      placeholder: 'https://connect.comma.ai/.../start/end',
      required: true,
      max_length: 512,
    });
    modal.addLabelComponents(
      new LabelBuilder().setLabel('Route URL').setTextInputComponent(urlInput),
    );

    const rtSelect = new StringSelectMenuBuilder()
      .setCustomId('clip_render_type')
      .setPlaceholder('Select a render type\u2026')
      .setMinValues(1)
      .addOptions(
        { label: 'UI', value: 'ui', description: 'openpilot UI overlay (default)', default: true },
        { label: 'UI Alt', value: 'ui-alt', description: 'Alternate UI composition' },
        { label: 'Driver Debug', value: 'driver-debug', description: 'Raw driver camera' },
        { label: 'Forward', value: 'forward', description: 'Road camera, fast transcode' },
        { label: 'Wide', value: 'wide', description: 'Wide-angle camera, fast transcode' },
        { label: 'Driver', value: 'driver', description: 'Driver camera, fast transcode' },
        { label: '360', value: '360', description: 'Equirectangular 360\u00b0 sphere' },
        { label: '360 UI', value: '360-ui', description: '360\u00b0 with HUD overlay' },
        { label: 'Forward Upon Wide', value: 'forward-upon-wide', description: 'Forward overlaid on wide' },
        { label: '360 Forward Upon Wide', value: '360-forward-upon-wide', description: '360\u00b0 + forward on wide (8K)' },
      );
    modal.addLabelComponents(
      new LabelBuilder().setLabel('Render Type').setStringSelectMenuComponent(rtSelect),
    );

    const fsInput = new TextInputBuilder({
      custom_id: 'clip_file_size',
      style: TextInputStyle.Short,
      placeholder: '5\u2013200, default: 9',
      required: false,
      max_length: 3,
    });
    modal.addLabelComponents(
      new LabelBuilder().setLabel('File Size (MB)').setTextInputComponent(fsInput),
    );

    const audioSelect = new StringSelectMenuBuilder()
      .setCustomId('clip_audio')
      .setPlaceholder('No')
      .addOptions(
        { label: 'No', value: 'false', default: true },
        { label: 'Yes', value: 'true' },
      );
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Include Audio')
        .setDescription('Copy audio from qcamera')
        .setStringSelectMenuComponent(audioSelect),
    );

    await interaction.showModal(modal);
  }

  @Slash({ description: 'openpilot UI overlay render', name: 'ui' })
  async ui(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'ui',
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Alternate UI composition (requires variant)', name: 'ui-alt' })
  async uiAlt(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashChoice(
      { name: 'Device', value: 'device' },
      { name: 'Stacked Forward / Wide', value: 'stacked_forward_over_wide' },
      { name: 'Stacked Wide / Forward', value: 'stacked_wide_over_forward' },
    )
    @SlashOption({
      name: 'variant',
      description: 'UI composition variant',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    variant: string,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'ui-alt',
      uiAltVariant: variant,
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Raw driver camera', name: 'driver-debug' })
  async driverDebug(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashChoice(
      { name: 'None', value: 'none' },
      { name: 'Driver Unchanged, Passenger Hidden', value: 'driver unchanged, passenger hidden' },
      { name: 'Driver Unchanged, Passenger Face Swap', value: 'driver unchanged, passenger face swap' },
      { name: 'Driver Face Swap, Passenger Unchanged', value: 'driver face swap, passenger unchanged' },
      { name: 'Driver Face Swap, Passenger Hidden', value: 'driver face swap, passenger hidden' },
      { name: 'Driver Face Swap, Passenger Face Swap', value: 'driver face swap, passenger face swap' },
    )
    @SlashOption({
      name: 'anonymization-profile',
      description: 'Face anonymization for driver camera renders',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    anonymizationProfile: string | undefined,
    @SlashChoice(
      { name: 'Blur', value: 'blur' },
      { name: 'Silhouette', value: 'silhouette' },
      { name: 'Black Silhouette', value: 'black_silhouette' },
      { name: 'IR Tint', value: 'ir_tint' },
    )
    @SlashOption({
      name: 'passenger-redaction-style',
      description: 'How hidden passengers are obscured (blur by default)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    passengerRedactionStyle: string | undefined,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'driver-debug',
      anonymizationProfile: anonymizationProfile || undefined,
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Road camera, fast transcode', name: 'forward' })
  async forward(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'forward',
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Wide-angle camera, fast transcode', name: 'wide' })
  async wide(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'wide',
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Driver camera, fast transcode', name: 'driver' })
  async driver(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashChoice(
      { name: 'None', value: 'none' },
      { name: 'Driver Unchanged, Passenger Hidden', value: 'driver unchanged, passenger hidden' },
      { name: 'Driver Unchanged, Passenger Face Swap', value: 'driver unchanged, passenger face swap' },
      { name: 'Driver Face Swap, Passenger Unchanged', value: 'driver face swap, passenger unchanged' },
      { name: 'Driver Face Swap, Passenger Hidden', value: 'driver face swap, passenger hidden' },
      { name: 'Driver Face Swap, Passenger Face Swap', value: 'driver face swap, passenger face swap' },
    )
    @SlashOption({
      name: 'anonymization-profile',
      description: 'Face anonymization for driver camera renders',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    anonymizationProfile: string | undefined,
    @SlashChoice(
      { name: 'Blur', value: 'blur' },
      { name: 'Silhouette', value: 'silhouette' },
      { name: 'Black Silhouette', value: 'black_silhouette' },
      { name: 'IR Tint', value: 'ir_tint' },
    )
    @SlashOption({
      name: 'passenger-redaction-style',
      description: 'How hidden passengers are obscured (blur by default)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    passengerRedactionStyle: string | undefined,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'driver',
      anonymizationProfile: anonymizationProfile || undefined,
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Equirectangular 360\u00b0 sphere', name: '360' })
  async s360(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashChoice(
      { name: 'None', value: 'none' },
      { name: 'Driver Unchanged, Passenger Hidden', value: 'driver unchanged, passenger hidden' },
      { name: 'Driver Unchanged, Passenger Face Swap', value: 'driver unchanged, passenger face swap' },
      { name: 'Driver Face Swap, Passenger Unchanged', value: 'driver face swap, passenger unchanged' },
      { name: 'Driver Face Swap, Passenger Hidden', value: 'driver face swap, passenger hidden' },
      { name: 'Driver Face Swap, Passenger Face Swap', value: 'driver face swap, passenger face swap' },
    )
    @SlashOption({
      name: 'anonymization-profile',
      description: 'Face anonymization for driver camera renders',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    anonymizationProfile: string | undefined,
    @SlashChoice(
      { name: 'Blur', value: 'blur' },
      { name: 'Silhouette', value: 'silhouette' },
      { name: 'Black Silhouette', value: 'black_silhouette' },
      { name: 'IR Tint', value: 'ir_tint' },
    )
    @SlashOption({
      name: 'passenger-redaction-style',
      description: 'How hidden passengers are obscured (blur by default)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    passengerRedactionStyle: string | undefined,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: '360',
      anonymizationProfile: anonymizationProfile || undefined,
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: '360\u00b0 with openpilot HUD overlay', name: '360-ui' })
  async s360Ui(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashChoice(
      { name: 'None', value: 'none' },
      { name: 'Driver Unchanged, Passenger Hidden', value: 'driver unchanged, passenger hidden' },
      { name: 'Driver Unchanged, Passenger Face Swap', value: 'driver unchanged, passenger face swap' },
      { name: 'Driver Face Swap, Passenger Unchanged', value: 'driver face swap, passenger unchanged' },
      { name: 'Driver Face Swap, Passenger Hidden', value: 'driver face swap, passenger hidden' },
      { name: 'Driver Face Swap, Passenger Face Swap', value: 'driver face swap, passenger face swap' },
    )
    @SlashOption({
      name: 'anonymization-profile',
      description: 'Face anonymization for driver camera renders',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    anonymizationProfile: string | undefined,
    @SlashChoice(
      { name: 'Blur', value: 'blur' },
      { name: 'Silhouette', value: 'silhouette' },
      { name: 'Black Silhouette', value: 'black_silhouette' },
      { name: 'IR Tint', value: 'ir_tint' },
    )
    @SlashOption({
      name: 'passenger-redaction-style',
      description: 'How hidden passengers are obscured (blur by default)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    passengerRedactionStyle: string | undefined,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: '360-ui',
      anonymizationProfile: anonymizationProfile || undefined,
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Forward camera overlaid on wide', name: 'forward-upon-wide' })
  async forwardUponWide(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'forward_upon_wide',
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: '360\u00b0 + forward on wide (up to 8K)', name: '360-forward-upon-wide' })
  async s360ForwardUponWide(
    @SlashOption({
      name: 'url',
      description: 'connect.comma.ai route URL with time range',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    @SlashChoice(
      { name: 'None', value: 'none' },
      { name: 'Driver Unchanged, Passenger Hidden', value: 'driver unchanged, passenger hidden' },
      { name: 'Driver Unchanged, Passenger Face Swap', value: 'driver unchanged, passenger face swap' },
      { name: 'Driver Face Swap, Passenger Unchanged', value: 'driver face swap, passenger unchanged' },
      { name: 'Driver Face Swap, Passenger Hidden', value: 'driver face swap, passenger hidden' },
      { name: 'Driver Face Swap, Passenger Face Swap', value: 'driver face swap, passenger face swap' },
    )
    @SlashOption({
      name: 'anonymization-profile',
      description: 'Face anonymization for driver camera renders',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    anonymizationProfile: string | undefined,
    @SlashChoice(
      { name: 'Blur', value: 'blur' },
      { name: 'Silhouette', value: 'silhouette' },
      { name: 'Black Silhouette', value: 'black_silhouette' },
      { name: 'IR Tint', value: 'ir_tint' },
    )
    @SlashOption({
      name: 'passenger-redaction-style',
      description: 'How hidden passengers are obscured (blur by default)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    passengerRedactionStyle: string | undefined,
    @SlashOption({
      name: 'file-size',
      description: 'Target file size in MB (5\u2013200, default: 9)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
    })
    fileSize: number | undefined,
    @SlashOption({
      name: 'include-audio',
      description: 'Include audio from qcamera (fails if unavailable)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: '360_forward_upon_wide',
      anonymizationProfile: anonymizationProfile || undefined,
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize: fileSize ?? undefined,
      includeAudio: includeAudio || undefined,
    });
  }

  @ModalComponent({ id: MODAL_ID })
  async handleFormModal(interaction: ModalSubmitInteraction) {
    const routeUrl = interaction.fields.getTextInputValue('clip_url').trim();
    const rtValues = interaction.fields.getStringSelectValues('clip_render_type');
    const rtRaw = rtValues.length > 0 ? rtValues[0] : 'ui';
    const fsRaw = interaction.fields.getTextInputValue('clip_file_size').trim();
    const audioValues = interaction.fields.getStringSelectValues('clip_audio');
    const includeAudio = audioValues.length > 0 ? audioValues[0] === 'true' : false;

    if (!(VALID_RENDER_TYPES as readonly string[]).includes(rtRaw)) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Invalid Render Type')
        .setDescription(
          `\`${rtRaw}\` is not valid.\n` +
          `Valid types: ${VALID_RENDER_TYPES.map(t => `\`${t}\``).join(', ')}`,
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const renderType = (RENDER_TYPE_MAP as Record<string, string>)[rtRaw];

    const input: ClipJobInput = {
      route: routeUrl,
      renderType,
      includeAudio: includeAudio || undefined,
    };

    if (fsRaw) {
      const size = parseInt(fsRaw, 10);
      if (isNaN(size) || size < 5 || size > 200) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.amber)
          .setTitle('Invalid File Size')
          .setDescription('File size must be a number between 5 and 200 MB.');
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }
      input.fileSize = size;
    }

    if (RENDER_TYPES_WITH_ANONYMIZATION.has(rtRaw)) {
      setPendingForm(interaction.user.id, input);
      const anonSelect = new StringSelectMenuBuilder()
        .setCustomId('clip_followup_anon')
        .setPlaceholder('Select anonymization profile\u2026')
        .setMinValues(1)
        .addOptions(
          ...ANONYMIZATION_PROFILES.map(p => ({ label: p.charAt(0).toUpperCase() + p.slice(1), value: p })),
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(anonSelect);
      const embed = new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setTitle('Anonymization Profile')
        .setDescription('Select a face anonymization profile for this render.');
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      return;
    }

    if (rtRaw === 'ui-alt') {
      setPendingForm(interaction.user.id, input);
      const select = new StringSelectMenuBuilder()
        .setCustomId('clip_followup_variant')
        .setPlaceholder('Select a variant\u2026')
        .setMinValues(1)
        .addOptions(
          { label: 'Device', value: 'device', description: 'Standard device view' },
          { label: 'Stacked Forward / Wide', value: 'stacked_forward_over_wide', description: 'Forward on top, wide below' },
          { label: 'Stacked Wide / Forward', value: 'stacked_wide_over_forward', description: 'Wide on top, forward below' },
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      const embed = new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setTitle('Choose Variant')
        .setDescription('Select a UI Alt composition variant.');
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      return;
    }

    await handleClipRequest(interaction, input);
  }

  @SelectMenuComponent({ id: 'clip_followup_anon' })
  async handleAnonSelect(interaction: AnySelectMenuInteraction) {
    const input = getPendingForm(interaction.user.id);
    if (!input) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Form Expired')
        .setDescription('Your previous form data expired. Please start over with `/clip form`.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const [profile] = interaction.values;
    if (profile && profile !== 'none') {
      input.anonymizationProfile = profile;

      const needsPrs = profile.includes('passenger hidden');
      if (needsPrs) {
        setPendingForm(interaction.user.id, input);
        const prsSelect = new StringSelectMenuBuilder()
          .setCustomId('clip_followup_prs')
          .setPlaceholder('Blur (default)')
          .addOptions(
            ...PASSENGER_REDACTION_STYLES.map(s => ({ label: s, value: s })),
          );
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(prsSelect);
        const embed = new EmbedBuilder()
          .setColor(COLORS.blurple)
          .setTitle('Passenger Redaction Style')
          .setDescription('Choose how hidden passengers are obscured.');
        await interaction.update({ embeds: [embed], components: [row] });
        return;
      }
    }

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip\u2026')],
      components: [],
    });
    await handleClipRequest(interaction, input);
  }

  @SelectMenuComponent({ id: 'clip_followup_prs' })
  async handlePrsSelect(interaction: AnySelectMenuInteraction) {
    const input = getPendingForm(interaction.user.id);
    if (!input) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Form Expired')
        .setDescription('Your previous form data expired. Please start over with `/clip form`.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const [style] = interaction.values;
    if (style) input.passengerRedactionStyle = style;

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip\u2026')],
      components: [],
    });
    await handleClipRequest(interaction, input);
  }

  @SelectMenuComponent({ id: 'clip_followup_variant' })
  async handleVariantSelect(interaction: AnySelectMenuInteraction) {
    const input = getPendingForm(interaction.user.id);
    if (!input) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Form Expired')
        .setDescription('Your previous form data expired. Please start over with `/clip form`.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const [variant] = interaction.values;
    if (variant) input.uiAltVariant = variant;

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip\u2026')],
      components: [],
    });
    await handleClipRequest(interaction, input);
  }

  @ButtonComponent({ id: /^clip_pub_/ })
  async publishClip(interaction: ButtonInteraction) {
    const jobId = interaction.customId.slice('clip_pub_'.length);
    const cached = getCachedClip(jobId);

    if (!cached) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Clip Expired')
        .setDescription('Cached clip has expired. Please create a new one.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isSendable()) {
      await interaction.reply({
        content: 'Cannot send messages in this channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const attachment = new AttachmentBuilder(cached.buffer, { name: 'clip.mp4' });
    await channel.send({ content: `<@${interaction.user.id}>`, files: [attachment] });

    deleteCachedClip(jobId);

    const updated = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle('Published')
      .setDescription('Your clip has been shared in the channel.');
    await interaction.update({ embeds: [updated], components: [], files: [], attachments: [] });
  }
}
