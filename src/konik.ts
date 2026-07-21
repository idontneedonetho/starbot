import { LRUCache } from 'lru-cache';
import { createZstdDecompress } from 'node:zlib';
import { createLogger } from './logger.js';
import type { RouteValidation } from './comma.js';
import type { Store } from './store.js';

const log = createLogger('konik');

export const KONIK_VIEWER_BASE = 'https://stable.konik.ai';

function apiBase(): string {
  return process.env.KONIK_API_BASE || 'https://api.konik.ai';
}

let currentToken: string | undefined;
let tokenStore: Store<{ token: string }> | null = null;

async function getTokenStore(): Promise<Store<{ token: string }>> {
  if (!tokenStore) {
    const { createStore } = await import('./store.js');
    tokenStore = createStore<{ token: string }>('konik-token');
  }
  return tokenStore;
}

function jwt(): string | undefined {
  return currentToken ?? process.env.KONIK_JWT ?? undefined;
}

export function konikEnabled(): boolean {
  return !!jwt();
}

export async function initKonikToken(): Promise<void> {
  try {
    const stored = await (await getTokenStore()).get('token');
    if (stored?.token) currentToken = stored.token;
  } catch (err) {
    log.warn({ err }, 'Failed to load persisted Konik token');
  }
}

export async function refreshKonikToken(): Promise<boolean> {
  const token = jwt();
  if (!token) return false;
  try {
    const res = await fetch(`${apiBase()}/v2/user/token`, { headers: { Authorization: `JWT ${token}` } });
    if (!res.ok) {
      log.warn({ status: res.status }, 'Konik token refresh failed; rotate KONIK_JWT if this persists');
      return false;
    }
    const data = await res.json() as { access_token?: string };
    if (!data.access_token) return false;
    currentToken = data.access_token;
    await (await getTokenStore()).set('token', { token: data.access_token });
    log.info('Konik token refreshed');
    return true;
  } catch (err) {
    log.warn({ err }, 'Konik token refresh error');
    return false;
  }
}

export function konikViewerUrl(dongleId: string, routeName: string): string {
  return `${KONIK_VIEWER_BASE}/${dongleId}/${routeName}`;
}

export interface KonikMetadata {
  gitRemote?: string;
  gitBranch?: string;
  gitCommit?: string;
  gitCommitDate?: string;
  gitDirty?: boolean;
  version?: string;
}

export interface KonikRouteInfo {
  valid: boolean;
  public: boolean;
  rlogsAvailable: boolean;
  metadata: KonikMetadata | null;
}

interface KonikFiles {
  logs?: string[];
  qlogs?: string[];
}

const QLOG_RANGE_BYTES = 65536;
const INIT_DATA_JSON_RE = /\{"channel":.*?"is_dirty":\s*(?:true|false)\}\}/;

const infoCache = new LRUCache<string, KonikRouteInfo>({ max: 200, ttl: 3 * 60_000 });

async function fetchFiles(dongleId: string, routeName: string): Promise<KonikFiles | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/route/${dongleId}|${routeName}/files`, {
      headers: { Authorization: `JWT ${jwt()}` },
    });
    if (!res.ok) return null;
    return await res.json() as KonikFiles;
  } catch (err) {
    log.warn({ err }, 'Konik /files request failed');
    return null;
  }
}

function decompressTruncatedFramePrefix(buf: Buffer): Promise<Buffer> {
  return new Promise(resolve => {
    const decodedPrefix: Buffer[] = [];
    const z = createZstdDecompress();
    const resolveWithDecodedPrefix = () => resolve(Buffer.concat(decodedPrefix));
    z.on('data', (c: Buffer) => decodedPrefix.push(c));
    z.on('error', resolveWithDecodedPrefix);
    z.on('end', resolveWithDecodedPrefix);
    z.end(buf);
  });
}

function cleanCommitDate(raw: string): string {
  const m = raw.match(/\d{4}-\d{2}-\d{2}[ T][\d:]{8}\s*[+-]\d{4}/);
  return m ? m[0] : raw.replace(/^'+|'+$/g, '').trim();
}

export function parseInitData(text: string): KonikMetadata {
  const meta: KonikMetadata = {};
  const jsonMatch = text.match(INIT_DATA_JSON_RE);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { channel?: string; openpilot?: Record<string, unknown> };
      const op = parsed.openpilot ?? {};
      if (typeof op.git_commit === 'string') meta.gitCommit = op.git_commit;
      if (typeof op.git_origin === 'string') meta.gitRemote = op.git_origin;
      if (typeof op.version === 'string') meta.version = op.version;
      if (typeof op.is_dirty === 'boolean') meta.gitDirty = op.is_dirty;
      if (typeof op.git_commit_date === 'string') meta.gitCommitDate = cleanCommitDate(op.git_commit_date);
      if (typeof parsed.channel === 'string') meta.gitBranch = parsed.channel;
    } catch (err) {
      log.warn({ err }, 'Failed to parse Konik initData JSON blob');
    }
  }
  if (!meta.gitCommit) meta.gitCommit = text.match(/\b[0-9a-f]{40}\b/)?.[0];
  if (!meta.gitRemote) meta.gitRemote = text.match(/https:\/\/github\.com\/[^\s"]+?\.git/)?.[0];
  return meta;
}

export async function getKonikRouteInfo(dongleId: string, routeName: string): Promise<KonikRouteInfo> {
  const key = `${dongleId}|${routeName}`;
  const cached = infoCache.get(key);
  if (cached) return cached;

  const info: KonikRouteInfo = { valid: false, public: false, rlogsAvailable: false, metadata: null };
  if (!konikEnabled()) return info;

  const files = await fetchFiles(dongleId, routeName);
  if (!files) return info;
  info.valid = true;
  info.rlogsAvailable = Array.isArray(files.logs) && files.logs.length > 0;

  const qlogUrl = files.qlogs?.[0];
  if (qlogUrl) {
    try {
      const res = await fetch(qlogUrl, { headers: { Range: `bytes=0-${QLOG_RANGE_BYTES - 1}` } });
      if (res.ok) {
        info.public = true;
        const buf = Buffer.from(await res.arrayBuffer());
        info.metadata = parseInitData((await decompressTruncatedFramePrefix(buf)).toString('latin1'));
      } else if (res.status === 401 || res.status === 403) {
        info.public = false;
      }
    } catch (err) {
      log.warn({ err }, 'Konik qlog fetch failed');
    }
  }

  infoCache.set(key, info);
  return info;
}

export async function validateKonikRoute(dongleId: string, routeName: string): Promise<RouteValidation> {
  if (!konikEnabled()) return { valid: false, public: false, rlogsAvailable: false, disabled: true };
  const info = await getKonikRouteInfo(dongleId, routeName);
  return {
    valid: info.valid,
    public: info.public,
    rlogsAvailable: info.rlogsAvailable,
    rlogCheck: { mode: 'whole', missing: [] },
  };
}
