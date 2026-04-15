import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { cleanEnv, str, num, makeValidator } from "envalid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cron = makeValidator((val: string) => {
  const regex = /^(\*|([0-5]?\d|\*)) (\*|([0-5]?\d|\*)) (\*|([0-2]?\d|\*)) (\*|([0-2]?\d|\*)) (\*|([0-6]|\*))$/;
  if (!regex.test(val)) throw new Error("Invalid cron expression");
  return val;
});

const defaultRepoCacheDir = path.resolve(__dirname, "../repo-cache/starpilot");
const defaultSessionDir = path.resolve(__dirname, "../data/sessions");

export const config = cleanEnv(process.env, {
  DISCORD_TOKEN: str(),
  DISCORD_CLIENT_ID: str({ default: "" }),
  LLM_PROVIDER: str({ default: "anthropic" }),
  LLM_API_KEY: str(),
  LLM_MODEL: str({ default: "claude-sonnet-4-5" }),
  CHEAP_LLM_PROVIDER: str({ default: "" }),
  CHEAP_LLM_MODEL: str({ default: "" }),
  STARPILOT_REPO_URL: str({ default: "https://github.com/firestar5683/starpilot" }),
  STARPILOT_BRANCH: str({ default: "StarPilot" }),
  REPO_CACHE_DIR: str({ default: defaultRepoCacheDir }),
  SESSION_DIR: str({ default: defaultSessionDir }),
  SYNC_CRON: cron({ default: "0 * * * *" }),
  ANSWER_TIMEOUT_SECONDS: num({ default: 90 }),
  ALLOWED_CHANNEL_IDS: str({ default: "" }),
});

export const ALLOWED_CHANNEL_IDS = config.ALLOWED_CHANNEL_IDS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const ANSWER_TIMEOUT_SECONDS = config.ANSWER_TIMEOUT_SECONDS ?? 90;
export const REPO_CACHE_DIR = config.REPO_CACHE_DIR ?? defaultRepoCacheDir;
export const SESSION_DIR = config.SESSION_DIR ?? defaultSessionDir;

export function validateConfig(): void {
  if (!config.LLM_MODEL || !config.REPO_CACHE_DIR || !config.SESSION_DIR) {
    throw new Error("[config] Invalid configuration");
  }
  if (ANSWER_TIMEOUT_SECONDS < 10 || ANSWER_TIMEOUT_SECONDS > 300) {
    throw new Error("[config] ANSWER_TIMEOUT_SECONDS must be between 10 and 300");
  }
  console.log("[config] Configuration validated");
}