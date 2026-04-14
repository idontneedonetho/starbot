import { simpleGit, type SimpleGit } from "simple-git";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

let git: SimpleGit | null = null;
let lastSuccessfulSync: Date | null = null;
let initPromise: Promise<void> | null = null;
let isInitialized = false;
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

/** Clones or updates the shallow repository cache */
export async function initRepo(): Promise<void> {
  if (initPromise) return initPromise;
  
  const dir = config.REPO_CACHE_DIR;

  const doInit = async () => {
    if (fs.existsSync(path.join(dir, ".git"))) {
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
  };

  initPromise = doInit();
  return initPromise;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synchronizes repo state with remote origin */
export async function syncRepo(): Promise<void> {
  if (initPromise) await initPromise;
  if (!git) {
    git = simpleGit(config.REPO_CACHE_DIR);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[repoSync] Syncing latest from remote (attempt ${attempt}/${MAX_RETRIES})...`);
      await git.fetch(["origin", config.STARPILOT_BRANCH, "--depth", "1"]);
      await git.reset(["--hard", `origin/${config.STARPILOT_BRANCH}`]);
      const log = await git.log({ maxCount: 1 });
      const latest = log.latest;
      console.log(
        `[repoSync] Up to date. Latest commit: ${latest?.hash?.slice(0, 8)} — ${latest?.message}`
      );
      lastSuccessfulSync = new Date();
      return;
    } catch (err) {
      lastError = err as Error;
      console.warn(`[repoSync] Attempt ${attempt} failed:`, err);
      if (attempt < MAX_RETRIES) {
        console.log(`[repoSync] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  console.error("[repoSync] Sync failed after all retries:", lastError);
  if (lastSuccessfulSync && Date.now() - lastSuccessfulSync.getTime() > STALE_THRESHOLD_MS) {
    console.warn(
      `[repoSync] ⚠️ Repo stale for ${Math.round((Date.now() - lastSuccessfulSync.getTime()) / 60_000)}min. Answers may be outdated.`
    );
  }
}

export function getRepoCacheDir(): string {
  return config.REPO_CACHE_DIR;
}

export function isRepoReady(): boolean {
  return isInitialized && lastSuccessfulSync !== null;
}

export function getLastSyncTime(): Date | null {
  return lastSuccessfulSync;
}

