import { simpleGit, type SimpleGit } from "simple-git";
import fs from "fs";
import path from "path";
import { loadRepos, REPO_CACHE_DIR, STALE_THRESHOLD_MS, SYNC_MAX_RETRIES, SYNC_RETRY_DELAY_MS, type RepoDef } from "./config.js";

interface RepoState {
  git: SimpleGit;
  lastSync: Date | null;
  failed: boolean;
}

const repos = new Map<string, RepoState>();
let initRan = false;
let initError: Error | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return SYNC_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
}

async function syncOne(def: RepoDef): Promise<void> {
  const dir = path.join(REPO_CACHE_DIR, def.name);

  let state = repos.get(def.name);
  if (!state) {
    state = { git: simpleGit(dir), lastSync: null, failed: false };
    repos.set(def.name, state);
  }

  for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
    try {
      console.log(`[repoSync] Syncing ${def.name} (attempt ${attempt}/${SYNC_MAX_RETRIES})...`);
      await state.git.fetch(["origin", def.branch, "--depth", "1"]);
      await state.git.reset(["--hard", `origin/${def.branch}`]);
      const log = await state.git.log({ maxCount: 1 });
      const latest = log.latest;
      console.log(`[repoSync] ${def.name} → ${latest?.hash?.slice(0, 8)} — ${latest?.message}`);
      state.lastSync = new Date();
      state.failed = false;
      return;
    } catch (err) {
      console.warn(`[repoSync] ${def.name} attempt ${attempt} failed:`, err);
      if (attempt < SYNC_MAX_RETRIES) {
        await sleep(retryDelay(attempt));
      }
    }
  }

  state.failed = true;
  console.error(`[repoSync] ${def.name} sync failed after ${SYNC_MAX_RETRIES} attempts`);

  if (state.lastSync && Date.now() - state.lastSync.getTime() > STALE_THRESHOLD_MS) {
    console.warn(`[repoSync] ${def.name} stale for ${Math.round((Date.now() - state.lastSync.getTime()) / 60_000)}min`);
  }
}

async function ensureOne(def: RepoDef): Promise<void> {
  const dir = path.join(REPO_CACHE_DIR, def.name);

  if (fs.existsSync(path.join(dir, ".git"))) {
    console.log(`[repoSync] ${def.name} exists at ${dir}. Pulling latest...`);
    const state: RepoState = { git: simpleGit(dir), lastSync: null, failed: false };
    repos.set(def.name, state);
    await syncOne(def);
    return;
  }

  console.log(`[repoSync] Cloning ${def.name} (${def.url}, branch: ${def.branch}) → ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const baseGit = simpleGit();
  await baseGit.clone(def.url, dir, ["--branch", def.branch, "--depth", "1", "--single-branch"]);
  console.log(`[repoSync] ${def.name} clone complete.`);
  repos.set(def.name, { git: simpleGit(dir), lastSync: new Date(), failed: false });
}

export function cleanupOrphanedRepos(): void {
  const configured = new Set(loadRepos().map(r => r.name));
  if (!fs.existsSync(REPO_CACHE_DIR)) return;

  for (const entry of fs.readdirSync(REPO_CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!configured.has(entry.name)) {
      const dirPath = path.join(REPO_CACHE_DIR, entry.name);
      console.log(`[repoSync] Removing orphaned repo: ${dirPath}`);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }
}

export async function initRepos(): Promise<void> {
  if (initRan) return;
  initRan = true;

  cleanupOrphanedRepos();

  const defs = loadRepos();
  if (defs.length === 0) {
    console.warn("[repoSync] No repos configured");
    return;
  }

  const results = await Promise.allSettled(defs.map(ensureOne));
  const failures = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
  if (failures.length > 0) {
    initError = new Error(`${failures.length} repo(s) failed to initialize`);
    for (const f of failures) console.error("[repoSync] Init failure:", f.reason);
  }
}

export async function syncRepos(): Promise<void> {
  const defs = loadRepos();
  if (defs.length === 0) return;

  for (const def of defs) {
    if (repos.has(def.name)) {
      await syncOne(def);
    } else {
      console.warn(`[repoSync] ${def.name} not initialized, cloning...`);
      await ensureOne(def);
    }
  }
}

export function isRepoReady(): boolean {
  if (repos.size === 0) return false;
  return Array.from(repos.values()).some(r => r.lastSync !== null);
}

export function getLastSyncTime(): Date | null {
  let latest: Date | null = null;
  for (const r of repos.values()) {
    if (r.lastSync && (!latest || r.lastSync > latest)) {
      latest = r.lastSync;
    }
  }
  return latest;
}

// Legacy aliases for backward compat
export const initRepo = initRepos;
export const syncRepo = syncRepos;
