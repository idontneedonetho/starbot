import { simpleGit, type SimpleGit } from "simple-git";
import fs from "fs";
import path from "path";
import { config, REPO_CACHE_DIR, STALE_THRESHOLD_MS, SYNC_MAX_RETRIES, SYNC_RETRY_DELAY_MS } from "./config.js";

let git: SimpleGit | null = null;
let lastSuccessfulSync: Date | null = null;
let initPromise: Promise<void> | null = null;
let isInitialized = false;
let syncFailed = false;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number): number {
  return SYNC_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
}

export async function initRepo(): Promise<void> {
  if (initPromise) return initPromise;
  
  const dir = REPO_CACHE_DIR;

  const doInit = async () => {
    try {
      const gitDir = path.join(dir, ".git");
      if (fs.existsSync(gitDir)) {
        console.log(`[repoSync] Repo already exists at ${dir}. Pulling latest...`);
        await syncRepo();
      } else {
        console.log(
          `[repoSync] Cloning ${config.STARPILOT_REPO_URL} (branch: ${config.STARPILOT_BRANCH}) → ${dir}`
        );
        fs.mkdirSync(dir, { recursive: true });
        const baseGit = simpleGit();
        await baseGit.clone(config.STARPILOT_REPO_URL, dir, [
          "--branch",
          config.STARPILOT_BRANCH,
          "--depth",
          "1",
          "--single-branch",
        ]);
        console.log(`[repoSync] Clone complete.`);
        lastSuccessfulSync = new Date();
      }
      git = simpleGit(dir);
      isInitialized = true;
    } catch (err) {
      console.error("[repoSync] Initial clone failed:", err);
      isInitialized = false;
      throw err;
    }
  };

  initPromise = doInit();
  return initPromise;
}

export async function syncRepo(): Promise<void> {
  if (initPromise) await initPromise;
  if (!git) {
    try {
      git = simpleGit(REPO_CACHE_DIR);
    } catch {
      console.warn("[repoSync] Cannot access repo directory");
      return;
    }
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
    try {
      console.log(`[repoSync] Syncing latest from remote (attempt ${attempt}/${SYNC_MAX_RETRIES})...`);
      await git.fetch(["origin", config.STARPILOT_BRANCH, "--depth", "1"]);
      await git.reset(["--hard", `origin/${config.STARPILOT_BRANCH}`]);
      const log = await git.log({ maxCount: 1 });
      const latest = log.latest;
      console.log(
        `[repoSync] Up to date. Latest commit: ${latest?.hash?.slice(0, 8)} — ${latest?.message}`
      );
      lastSuccessfulSync = new Date();
      syncFailed = false;
      return;
    } catch (err) {
      lastError = err as Error;
      console.warn(`[repoSync] Attempt ${attempt} failed:`, err);
      if (attempt < SYNC_MAX_RETRIES) {
        const delay = getRetryDelay(attempt);
        console.log(`[repoSync] Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }

  syncFailed = true;
  console.error("[repoSync] Sync failed after all retries:", lastError);
  if (lastSuccessfulSync && Date.now() - lastSuccessfulSync.getTime() > STALE_THRESHOLD_MS) {
    console.warn(
      `[repoSync] Repo stale for ${Math.round((Date.now() - lastSuccessfulSync.getTime()) / 60_000)}min. Answers may be outdated.`
    );
  }
}

export function getRepoCacheDir(): string {
  return REPO_CACHE_DIR;
}

export function isRepoReady(): boolean {
  return isInitialized && lastSuccessfulSync !== null && !syncFailed;
}

export function getLastSyncTime(): Date | null {
  return lastSuccessfulSync;
}

