import { simpleGit, type SimpleGit } from "simple-git";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

let git: SimpleGit | null = null;
let lastSuccessfulSync: Date | null = null;
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** Clones or updates the shallow repository cache */
export async function initRepo(): Promise<void> {
  const dir = config.REPO_CACHE_DIR;

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
}

/** Synchronizes repo state with remote origin */
export async function syncRepo(): Promise<void> {
  if (!git) {
    git = simpleGit(config.REPO_CACHE_DIR);
  }

  try {
    console.log(`[repoSync] Syncing latest from remote...`);
    await git.fetch(["origin", config.STARPILOT_BRANCH, "--depth", "1"]);
    await git.reset(["--hard", `origin/${config.STARPILOT_BRANCH}`]);
    const log = await git.log({ maxCount: 1 });
    const latest = log.latest;
    console.log(
      `[repoSync] Up to date. Latest commit: ${latest?.hash?.slice(0, 8)} — ${latest?.message}`
    );
    lastSuccessfulSync = new Date();
  } catch (err) {
    console.error("[repoSync] Sync failed:", err);
    if (lastSuccessfulSync && Date.now() - lastSuccessfulSync.getTime() > STALE_THRESHOLD_MS) {
      console.warn(
        `[repoSync] ⚠️ Repo stale for ${Math.round((Date.now() - lastSuccessfulSync.getTime()) / 60_000)}min. Answers may be outdated.`
      );
    }
  }
}

export function getRepoCacheDir(): string {
  return config.REPO_CACHE_DIR;
}

