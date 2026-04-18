import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { cleanEnv, str, num, makeValidator } from "envalid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultRepoCacheDir = path.resolve(__dirname, "../repo-cache/starpilot");
const defaultSessionDir = path.resolve(__dirname, "../data/sessions");
const defaultPluginsDir = path.resolve(__dirname, "../data/plugins");
const defaultBotSrcDir = path.resolve(__dirname, "../src");

const cronValidator = makeValidator((val: string) => {
  const regex = /^(\*|([0-5]?\d|\*)) (\*|([0-5]?\d|\*)) (\*|([0-2]?\d|\*)) (\*|([0-2]?\d|\*)) (\*|([0-6]|\*))$/;
  if (!regex.test(val)) throw new Error("Invalid cron expression");
  return val;
});

export const config = cleanEnv(process.env, {
  DISCORD_TOKEN: str(),
  DISCORD_CLIENT_ID: str({ default: "" }),
  LLM_PROVIDER: str({ default: "anthropic" }),
  LLM_API_KEY: str(),
  LLM_MODEL: str({ default: "claude-sonnet-4-5" }),
  CHEAP_LLM_PROVIDER: str({ default: "" }),
  CHEAP_LLM_MODEL: str({ default: "" }),
  REPO_NAME: str({ default: "StarPilot" }),
  REPO_DESC: str({ default: "a custom fork of comma.ai's openpilot driving assistance system with special support for GM vehicles" }),
  STARPILOT_REPO_URL: str({ default: "https://github.com/firestar5683/starpilot" }),
  STARPILOT_BRANCH: str({ default: "StarPilot" }),
  REPO_CACHE_DIR: str({ default: defaultRepoCacheDir }),
  SESSION_DIR: str({ default: defaultSessionDir }),
  PLUGINS_DIR: str({ default: defaultPluginsDir }),
  SYNC_CRON: cronValidator({ default: "0 * * * *" }),
  ANSWER_TIMEOUT_SECONDS: num({ default: 90 }),
  ALLOWED_CHANNEL_IDS: str({ default: "" }),
  RATE_LIMIT_WINDOW_SEC: num({ default: 60 }),
  RATE_LIMIT_MAX: num({ default: 3 }),
  MAX_CONCURRENT: num({ default: 2 }),
  SESSION_MAX_AGE_DAYS: num({ default: 30 }),
  DB_PATH: str({ default: path.resolve(__dirname, "../data/memories.db") }),
  STALE_THRESHOLD_MS: num({ default: 7200000 }),
  SYNC_MAX_RETRIES: num({ default: 3 }),
  SYNC_RETRY_DELAY_MS: num({ default: 5000 }),
  MAX_FACTS: num({ default: 5 }),
  MIN_CONFIDENCE: num({ default: 3 }),
});

export const ALLOWED_CHANNEL_IDS = config.ALLOWED_CHANNEL_IDS
  ? config.ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const ANSWER_TIMEOUT_SECONDS = config.ANSWER_TIMEOUT_SECONDS;
export const REPO_CACHE_DIR = config.REPO_CACHE_DIR;
export const SESSION_DIR = config.SESSION_DIR;
export const REPO_NAME = config.REPO_NAME;
export const REPO_DESC = config.REPO_DESC;
export const PLUGINS_DIR = config.PLUGINS_DIR;
export const RATE_LIMIT_WINDOW_SEC = config.RATE_LIMIT_WINDOW_SEC;
export const RATE_LIMIT_MAX = config.RATE_LIMIT_MAX;
export const MAX_CONCURRENT = config.MAX_CONCURRENT;
export const SESSION_MAX_AGE_DAYS = config.SESSION_MAX_AGE_DAYS;
export const DB_PATH = config.DB_PATH;
export const STALE_THRESHOLD_MS = config.STALE_THRESHOLD_MS;
export const SYNC_MAX_RETRIES = config.SYNC_MAX_RETRIES;
export const SYNC_RETRY_DELAY_MS = config.SYNC_RETRY_DELAY_MS;
export const MAX_FACTS = config.MAX_FACTS;
export const MIN_CONFIDENCE = config.MIN_CONFIDENCE;
export const BOT_SRC_DIR = process.env.BOT_SRC_DIR || defaultBotSrcDir;

export function validateConfig(): void {
  if (!config.LLM_MODEL || !REPO_CACHE_DIR || !SESSION_DIR) {
    throw new Error("[config] Invalid configuration");
  }
  if (ANSWER_TIMEOUT_SECONDS < 10 || ANSWER_TIMEOUT_SECONDS > 300) {
    throw new Error("[config] ANSWER_TIMEOUT_SECONDS must be between 10 and 300");
  }
  console.log("[config] Configuration validated");
}