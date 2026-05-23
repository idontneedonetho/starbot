import {
  Discord,
  Slash,
  SlashGroup,
  SlashOption,
  SlashChoice,
  Guild,
} from 'discordx';
import {
  ApplicationCommandOptionType,
  type CommandInteraction,
} from 'discord.js';
import {
  handleClipRequest,
  type ClipJobInput,
} from './clip.js';
import { loadConfig } from '../config.js';

const guildId = loadConfig().guildId;

@Discord()
@Guild(guildId)
@SlashGroup({ description: 'Create replay clips from comma connect routes', name: 'clip' })
@SlashGroup('clip')
export class ClipCommands {

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
}
