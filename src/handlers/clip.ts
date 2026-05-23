import type { CommandInteraction, ModalSubmitInteraction, AnySelectMenuInteraction } from 'discord.js';
import {
  AttachmentBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { COLORS } from '../util.js';

export interface ClipConfig {
  endpoint: string;
  apiKey: string;
  maxDuration: number;
}

export interface ClipJobInput {
  route: string;
  renderType?: string;
  uiAltVariant?: string;
  fileSize?: number;
  includeAudio?: boolean;
  anonymizationProfile?: string;
  passengerRedactionStyle?: string;
}

export const RENDER_TYPE_MAP: Record<string, string> = {
  'ui': 'ui',
  'ui-alt': 'ui-alt',
  'driver-debug': 'driver-debug',
  'forward': 'forward',
  'wide': 'wide',
  'driver': 'driver',
  '360': '360',
  '360-ui': '360-ui',
  'forward-upon-wide': 'forward_upon_wide',
  '360-forward-upon-wide': '360_forward_upon_wide',
};

export const VALID_RENDER_TYPES = Object.keys(RENDER_TYPE_MAP);

export const ANONYMIZATION_PROFILES = [
  'none',
  'driver unchanged, passenger hidden',
  'driver unchanged, passenger face swap',
  'driver face swap, passenger unchanged',
  'driver face swap, passenger hidden',
  'driver face swap, passenger face swap',
] as const;

export const PASSENGER_REDACTION_STYLES = [
  'blur',
  'silhouette',
  'black_silhouette',
  'ir_tint',
] as const;

export const UI_ALT_VARIANTS = [
  'device',
  'stacked_forward_over_wide',
  'stacked_wide_over_forward',
] as const;

export const RENDER_TYPES_WITH_ANONYMIZATION = new Set([
  'driver-debug', 'driver', '360', '360-ui', '360_forward_upon_wide',
]);

const activeUsers = new Set<string>();

export function acquireUserLock(userId: string): boolean {
  if (activeUsers.has(userId)) return false;
  activeUsers.add(userId);
  return true;
}

export function releaseUserLock(userId: string): void {
  activeUsers.delete(userId);
}

export function getClipConfig(): ClipConfig | null {
  const endpoint = process.env.OP_REPLAY_CLIPPER_ENDPOINT;
  const apiKey = process.env.OP_REPLAY_CLIPPER_API_KEY;
  if (!endpoint || !apiKey) return null;
  const raw = parseInt(process.env.OP_REPLAY_CLIPPER_MAX_DURATION || '60', 10);
  const maxDuration = isNaN(raw) || raw <= 0 ? 60 : raw;
  return { endpoint: endpoint.replace(/\/+$/, ''), apiKey, maxDuration };
}

export function parseRouteUrl(url: string): { route: string; duration: number } | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== 'connect.comma.ai') return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 3) return null;

    const end = parseInt(segments[segments.length - 1], 10);
    const start = parseInt(segments[segments.length - 2], 10);
    if (isNaN(end) || isNaN(start) || end <= start) return null;

    const diff = end - start;
    const durationSec = start > 1e10 ? diff / 1000 : diff;
    if (durationSec <= 0) return null;

    return { route: url.trim(), duration: durationSec };
  } catch {
    return null;
  }
}

interface CachedClip {
  buffer: Buffer;
  renderType: string;
  sizeBytes: number;
  createdAt: number;
}

const clipCache = new Map<string, CachedClip>();
const CACHE_TTL = 5 * 60 * 1000;

export function getCachedClip(jobId: string): CachedClip | undefined {
  const c = clipCache.get(jobId);
  if (!c) return undefined;
  if (Date.now() - c.createdAt > CACHE_TTL) {
    clipCache.delete(jobId);
    return undefined;
  }
  return c;
}

export function deleteCachedClip(jobId: string): void {
  clipCache.delete(jobId);
}

function cacheClip(jobId: string, data: ArrayBuffer, renderType: string): void {
  const now = Date.now();
  for (const [k, v] of clipCache) {
    if (now - v.createdAt > CACHE_TTL) clipCache.delete(k);
  }
  clipCache.set(jobId, {
    buffer: Buffer.from(data),
    renderType,
    sizeBytes: data.byteLength,
    createdAt: now,
  });
}

interface SubmitResponse {
  job_id: string;
  status: 'queued';
  queue: 'pending' | 'slow';
  queue_position: number;
  estimated_wait_seconds: number | null;
}

interface JobStatus {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  queue: 'pending' | 'slow' | null;
  progress_pct: number | null;
  progress_detail: string | null;
  fps: number | null;
  runner: string | null;
  result_cached: boolean;
  error: string | null;
  attempts: number;
  created_at: number | null;
  started_at: number | null;
  completed_at: number | null;
}

async function submitJob(config: ClipConfig, input: ClipJobInput): Promise<SubmitResponse> {
  const res = await fetch(`${config.endpoint}/predict`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Clip API returned ${res.status}: ${text || res.statusText}`);
  }

  return res.json() as Promise<SubmitResponse>;
}

async function getJobStatus(config: ClipConfig, jobId: string): Promise<JobStatus> {
  const res = await fetch(`${config.endpoint}/jobs/${jobId}`, {
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });

  if (res.ok) return res.json() as Promise<JobStatus>;

  if (res.status === 404) throw new Error(`Job ${jobId} not found`);
  throw new Error(`Failed to check job status (${res.status})`);
}

async function downloadOutput(config: ClipConfig, jobId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${config.endpoint}/jobs/${jobId}/output`, {
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error('Clip output expired (TTL is 1 hour). Please try again.');
    throw new Error(`Failed to download clip (${res.status})`);
  }

  return res.arrayBuffer();
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${Math.round(pct)}%`;
}

export interface ProgressUpdate {
  pct: number | null;
  detail: string;
  queuePosition?: number;
  queue?: string | null;
  eta?: number | null;
  fps?: number | null;
}

export type ProgressCallback = (update: ProgressUpdate) => Promise<void>;

export function createProgressUpdater(
  interaction: CommandInteraction | ModalSubmitInteraction | AnySelectMenuInteraction,
): ProgressCallback {
  let lastUpdate = 0;
  return async (update) => {
    const now = Date.now();
    if (now - lastUpdate < 4000) return;
    lastUpdate = now;
    try {
      const embed = new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip');

      if (update.queuePosition !== undefined) {
        const queueLabel = update.queue === 'slow' ? 'Slow Queue' : 'Queue';
        embed.addFields(
          { name: 'Status', value: queueLabel, inline: true },
          { name: 'Position', value: `${update.queuePosition}`, inline: true },
          { name: 'ETA', value: update.eta != null ? `~${Math.ceil(update.eta)}s` : '\u2014', inline: true },
        );
      } else if (update.pct !== null) {
        const detailStr = update.fps != null
          ? `\`${update.detail}\` (${update.fps} fps)`
          : `\`${update.detail}\``;
        embed.addFields(
          { name: 'Progress', value: progressBar(update.pct), inline: false },
          { name: 'Detail', value: detailStr, inline: false },
        );
      } else {
        embed.setDescription(`\`${update.detail}\``);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch { /* rate-limited or interaction expired */ }
  };
}

export async function processClip(
  config: ClipConfig,
  input: ClipJobInput,
  onProgress: ProgressCallback,
): Promise<{ data: ArrayBuffer; jobId: string }> {
  const submitRes = await submitJob(config, input);
  const jobId = submitRes.job_id;
  const pos = submitRes.queue_position === -1 ? 0 : submitRes.queue_position;
  await onProgress({ pct: null, detail: 'Queued', queuePosition: pos, queue: submitRes.queue, eta: submitRes.estimated_wait_seconds });

  const POLL_INTERVAL = 3000;
  const MAX_TIME = 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < MAX_TIME) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const status = await getJobStatus(config, jobId);

    if (status.status === 'completed') {
      const data = await downloadOutput(config, jobId);
      return { data, jobId };
    }
    if (status.status === 'failed') throw new Error(status.error || 'Clip processing failed');

    const detail = status.progress_detail
      ?? (status.status === 'queued' ? 'Waiting in queue\u2026' : 'Processing\u2026');
    await onProgress({ pct: status.progress_pct, detail, queue: status.queue, fps: status.fps });
  }

  throw new Error('Clip processing timed out after 10 minutes');
}

async function sendEphemeral(
  interaction: CommandInteraction | ModalSubmitInteraction | AnySelectMenuInteraction,
  title: string,
  description: string,
): Promise<void> {
  const embed = new EmbedBuilder().setColor(COLORS.amber).setTitle(title).setDescription(description);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] as [MessageFlags.Ephemeral] });
  }
}

export async function handleClipRequest(
  interaction: CommandInteraction | ModalSubmitInteraction | AnySelectMenuInteraction,
  input: ClipJobInput,
): Promise<void> {
  const config = getClipConfig();
  if (!config) {
    await sendEphemeral(interaction, 'Service Unavailable', 'Clip service is not configured. Contact an admin.');
    return;
  }

  const parsed = parseRouteUrl(input.route);
  if (!parsed) {
    await sendEphemeral(interaction,
      'Invalid Route URL',
      'Must be a connect.comma.ai URL with a time range:\n' +
      '`https://connect.comma.ai/{dongle_id}/{route_id}/{start}/{end}`',
    );
    return;
  }

  if (parsed.duration > config.maxDuration) {
    await sendEphemeral(interaction,
      'Duration Exceeds Limit',
      `Requested **${Math.round(parsed.duration)}s** — maximum is **${config.maxDuration}s**.`,
    );
    return;
  }

  const userId = interaction.user.id;
  if (!acquireUserLock(userId)) {
    await sendEphemeral(interaction,
      'Clip In Progress',
      'You already have a clip being processed. Wait for it to finish before requesting another.',
    );
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    const onProgress = createProgressUpdater(interaction);
    const { data, jobId } = await processClip(config, input, onProgress);

    const maxBytes = 25 * 1024 * 1024;
    if (data.byteLength > maxBytes) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Clip Too Large')
        .setDescription(
          `Result is **${(data.byteLength / 1024 / 1024).toFixed(1)} MB** — Discord limit is 25 MB.\n` +
          `Try a lower \`file-size\` value (target was ${input.fileSize ?? 9} MB).`,
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const renderLabel = input.renderType ?? 'ui';
    const sizeLabel = `${(data.byteLength / 1024 / 1024).toFixed(1)} MB`;

    cacheClip(jobId, data, renderLabel);

    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle('Clip Ready')
      .addFields(
        { name: 'Type', value: `\`${renderLabel}\``, inline: true },
        { name: 'Size', value: sizeLabel, inline: true },
      )
      .setFooter({ text: 'Click Publish to share in channel' });

    const attachment = new AttachmentBuilder(Buffer.from(data), { name: 'clip.mp4' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`clip_pub_${jobId}`)
        .setLabel('Publish')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({ embeds: [embed], files: [attachment], components: [row] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[clip]', msg);
    try {
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Clip Failed')
        .setDescription(msg);
      await interaction.editReply({ embeds: [embed] });
    } catch { /* interaction may have expired */ }
  } finally {
    releaseUserLock(userId);
  }
}

export function parseAdvancedOptions(text: string): Partial<ClipJobInput> {
  const result: Partial<ClipJobInput> = {};
  for (const line of text.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();

    if (key === 'includeaudio') {
      result.includeAudio = val === 'true';
    } else if (key === 'anonymizationprofile' && (ANONYMIZATION_PROFILES as readonly string[]).includes(val)) {
      result.anonymizationProfile = val;
    } else if (key === 'passengerredactionstyle' && (PASSENGER_REDACTION_STYLES as readonly string[]).includes(val)) {
      result.passengerRedactionStyle = val;
    } else if (key === 'uialtvariant' && (UI_ALT_VARIANTS as readonly string[]).includes(val)) {
      result.uiAltVariant = val;
    }
  }
  return result;
}
