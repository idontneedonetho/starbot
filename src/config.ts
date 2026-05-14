import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { cleanEnv, str, num, makeValidator } from "envalid";
import cron from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultRepoCacheDir = path.resolve(__dirname, "../repo-cache");
const defaultSessionDir = path.resolve(__dirname, "../data/sessions");
const defaultPluginsDir = path.resolve(__dirname, "../data/plugins");
const defaultBotSrcDir = path.resolve(__dirname, "../src");
const defaultWikiDir = path.resolve(__dirname, "../data/wikis");

const cronValidator = makeValidator((val: string) => {
  if (!cron.validate(val)) throw new Error(`Invalid cron expression: "${val}"`);
  return val;
});

export interface RepoDef {
  name: string;
  url: string;
  branch: string;
  desc: string;
}

export const config = cleanEnv(process.env, {
  DISCORD_TOKEN: str(),
  LLM_PROVIDER: str({ default: "anthropic" }),
  LLM_API_KEY: str(),
  LLM_MODEL: str({ default: "claude-sonnet-4-5" }),
  CHEAP_LLM_PROVIDER: str({ default: "" }),
  CHEAP_LLM_MODEL: str({ default: "" }),
  REPOS: str({ default: "" }),
  REPO_NAME: str({ default: "StarPilot" }),
  REPO_DESC: str({ default: "a custom fork of comma.ai's openpilot driving assistance system with special support for GM vehicles" }),
  STARPILOT_REPO_URL: str({ default: "https://github.com/firestar5683/starpilot" }),
  STARPILOT_BRANCH: str({ default: "StarPilot" }),
  REPO_CACHE_DIR: str({ default: defaultRepoCacheDir }),
  SESSION_DIR: str({ default: defaultSessionDir }),
  PLUGINS_DIR: str({ default: defaultPluginsDir }),
  BOT_SRC_DIR: str({ default: defaultBotSrcDir }),
  WIKI_DIR: str({ default: defaultWikiDir }),
  ADMIN_USER_IDS: str({ default: "" }),
  SYNC_CRON: cronValidator({ default: "0 * * * *" }),
  ANSWER_TIMEOUT_SECONDS: num({ default: 90 }),
  ALLOWED_CHANNEL_IDS: str({ default: "" }),
  RATE_LIMIT_WINDOW_SEC: num({ default: 60 }),
  RATE_LIMIT_MAX: num({ default: 3 }),
  MAX_CONCURRENT: num({ default: 2 }),
  STALE_THRESHOLD_MS: num({ default: 7200000 }),
  SYNC_MAX_RETRIES: num({ default: 3 }),
  SYNC_RETRY_DELAY_MS: num({ default: 5000 }),
});

export const ALLOWED_CHANNEL_IDS = config.ALLOWED_CHANNEL_IDS
  ? config.ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const ADMIN_USER_IDS = config.ADMIN_USER_IDS
  ? config.ADMIN_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const ANSWER_TIMEOUT_SECONDS = config.ANSWER_TIMEOUT_SECONDS;
export const REPO_CACHE_DIR = config.REPO_CACHE_DIR;
export const SESSION_DIR = config.SESSION_DIR;
export const PLUGINS_DIR = config.PLUGINS_DIR;
export const DATA_DIR = path.resolve(PLUGINS_DIR, "..");
export const BOT_SRC_DIR = config.BOT_SRC_DIR;
export const WIKI_DIR = config.WIKI_DIR;
export const RATE_LIMIT_WINDOW_SEC = config.RATE_LIMIT_WINDOW_SEC;
export const RATE_LIMIT_MAX = config.RATE_LIMIT_MAX;
export const MAX_CONCURRENT = config.MAX_CONCURRENT;
export const STALE_THRESHOLD_MS = config.STALE_THRESHOLD_MS;
export const SYNC_MAX_RETRIES = config.SYNC_MAX_RETRIES;
export const SYNC_RETRY_DELAY_MS = config.SYNC_RETRY_DELAY_MS;

export function loadRepos(): RepoDef[] {
  if (config.REPOS) {
    try {
      return JSON.parse(config.REPOS);
    } catch {
      throw new Error(`[config] Invalid REPOS JSON: ${config.REPOS}`);
    }
  }
  return [{
    name: config.REPO_NAME,
    url: config.STARPILOT_REPO_URL,
    branch: config.STARPILOT_BRANCH,
    desc: config.REPO_DESC,
  }];
}

export function validateConfig(): void {
  if (!config.LLM_MODEL || !REPO_CACHE_DIR || !SESSION_DIR || !PLUGINS_DIR) {
    throw new Error("[config] Invalid configuration");
  }
  if (ANSWER_TIMEOUT_SECONDS < 10 || ANSWER_TIMEOUT_SECONDS > 300) {
    throw new Error("[config] ANSWER_TIMEOUT_SECONDS must be between 10 and 300");
  }
  console.log("[config] Configuration validated");
}