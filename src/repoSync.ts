import { simpleGit, type SimpleGit } from "simple-git";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

let git: SimpleGit | null = null;

/**
 * Clones the StarPilot repo on first run, or pulls updates if already present.
 * Uses a shallow clone (--depth 1) to avoid fetching the full commit history.
 */
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
  }

  git = simpleGit(dir);
}

/**
 * Pulls the latest changes from the remote. Safe to call on a schedule.
 */
export async function syncRepo(): Promise<void> {
  if (!git) {
    git = simpleGit(config.REPO_CACHE_DIR);
  }

  try {
    console.log(`[repoSync] Syncing latest from remote...`);
    // Unshallow fetch is unnecessary — we just fetch the tip of the branch.
    await git.fetch(["origin", config.STARPILOT_BRANCH, "--depth", "1"]);
    await git.reset(["--hard", `origin/${config.STARPILOT_BRANCH}`]);
    const log = await git.log({ maxCount: 1 });
    const latest = log.latest;
    console.log(
      `[repoSync] Up to date. Latest commit: ${latest?.hash?.slice(0, 8)} — ${latest?.message}`
    );
  } catch (err) {
    console.error("[repoSync] Sync failed:", err);
  }
}

/**
 * Returns the absolute path to the local repo cache.
 */
export function getRepoCacheDir(): string {
  return config.REPO_CACHE_DIR;
}
