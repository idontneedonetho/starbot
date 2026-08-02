import { LRUCache } from 'lru-cache';
import { createLogger } from './logger.js';
import type { RouteValidation } from './comma.js';

const log = createLogger('konik');

export const KONIK_VIEWER_BASE = 'https://stable.konik.ai';

function apiBase(): string {
  return process.env.KONIK_API_BASE || 'https://api.konik.ai';
}

export function konikViewerUrl(dongleId: string, routeName: string): string {
  return `${KONIK_VIEWER_BASE}/${dongleId}/${routeName}`;
}

export interface KonikMetadata {
  gitRemote?: string;
  gitBranch?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  platform?: string;
}

export interface KonikRouteInfo {
  valid: boolean;
  public: boolean;
  rlogsAvailable: boolean;
  metadata: KonikMetadata | null;
}

interface KonikRouteInfoResponse {
  is_public: boolean;
  git_remote: string | null;
  git_branch: string | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  platform: string | null;
  maxqlog: number;
}

interface KonikFiles {
  logs?: string[];
  qlogs?: string[];
}

const infoCache = new LRUCache<string, KonikRouteInfo>({ max: 200, ttl: 3 * 60_000 });

async function fetchRouteInfo(dongleId: string, routeName: string): Promise<KonikRouteInfoResponse | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/route/${dongleId}|${routeName}`);
    if (!res.ok) return null;
    return await res.json() as KonikRouteInfoResponse;
  } catch (err) {
    log.warn({ err }, 'Konik route info request failed');
    return null;
  }
}

async function fetchFiles(dongleId: string, routeName: string): Promise<KonikFiles | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/route/${dongleId}|${routeName}/files`);
    if (!res.ok) return null;
    return await res.json() as KonikFiles;
  } catch (err) {
    log.warn({ err }, 'Konik /files request failed');
    return null;
  }
}

// Konik's /files URLs are path-based (.../connectdata/{dongle}/{route}/{segment}/rlog.zst),
// unlike comma's dongle_route--segment--filetype naming, so the segment lives in its own path part.
function segmentHasRlog(logs: string[], dongleId: string, routeName: string, seg: number): boolean {
  const needle = `/${dongleId}/${routeName}/${seg}/rlog`.toLowerCase();
  return logs.some(u => u.toLowerCase().includes(needle));
}

export async function getKonikRouteInfo(dongleId: string, routeName: string): Promise<KonikRouteInfo> {
  const key = `${dongleId}|${routeName}`;
  const cached = infoCache.get(key);
  if (cached) return cached;

  const info: KonikRouteInfo = { valid: false, public: false, rlogsAvailable: false, metadata: null };

  const route = await fetchRouteInfo(dongleId, routeName);
  if (!route) return info;
  info.valid = true;
  info.public = !!route.is_public;
  info.metadata = {
    gitRemote: route.git_remote ?? undefined,
    gitBranch: route.git_branch ?? undefined,
    gitCommit: route.git_commit ?? undefined,
    gitDirty: route.git_dirty ?? undefined,
    platform: route.platform ?? undefined,
  };

  if (info.public) {
    const files = await fetchFiles(dongleId, routeName);
    const logs = Array.isArray(files?.logs) ? files.logs : [];
    const expectedSegments = route.maxqlog + 1;
    info.rlogsAvailable = expectedSegments > 0 && logs.length === expectedSegments;
  }

  infoCache.set(key, info);
  return info;
}

export async function validateKonikRoute(
  dongleId: string,
  routeName: string,
  startSegment?: number,
  endSegment?: number,
): Promise<RouteValidation> {
  const info = await getKonikRouteInfo(dongleId, routeName);
  if (!info.valid) return { valid: false, public: false, rlogsAvailable: false };
  if (!info.public) return { valid: true, public: false, rlogsAvailable: false };
  if (startSegment === undefined) {
    return { valid: true, public: true, rlogsAvailable: info.rlogsAvailable, rlogCheck: { mode: 'whole', missing: [] } };
  }

  const files = await fetchFiles(dongleId, routeName);
  const logs = Array.isArray(files?.logs) ? files.logs : [];
  const lo = Math.min(startSegment, endSegment ?? startSegment);
  const hi = Math.max(startSegment, endSegment ?? startSegment);
  const missing: number[] = [];
  for (let s = lo; s <= hi; s++) {
    if (!segmentHasRlog(logs, dongleId, routeName, s)) missing.push(s);
  }
  return { valid: true, public: true, rlogsAvailable: missing.length === 0, rlogCheck: { mode: 'segment', missing } };
}
