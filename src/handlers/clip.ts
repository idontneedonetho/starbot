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
