import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function validateChannelIds(ids: string[]): string[] {
  const valid: string[] = [];
  const discordIdRegex = /^\d{17,19}$/;
  for (const id of ids) {
    if (!discordIdRegex.test(id)) {
      console.warn(`[config] Invalid channel ID "${id}" - skipping`);
    } else {
      valid.push(id);
    }
  }
  return valid;
}

/** Centralized configuration schema */
export const config = {
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: optionalEnv("DISCORD_CLIENT_ID", ""),

  LLM_PROVIDER: optionalEnv("LLM_PROVIDER", "anthropic"),
  LLM_API_KEY: requireEnv("LLM_API_KEY"),
  LLM_MODEL: optionalEnv("LLM_MODEL", "claude-sonnet-4-5"),

  CHEAP_LLM_PROVIDER: optionalEnv("CHEAP_LLM_PROVIDER", ""),
  CHEAP_LLM_MODEL: optionalEnv("CHEAP_LLM_MODEL", ""),

  STARPILOT_REPO_URL: optionalEnv(
    "STARPILOT_REPO_URL",
    "https://github.com/firestar5683/starpilot"
  ),
  STARPILOT_BRANCH: optionalEnv("STARPILOT_BRANCH", "StarPilot"),
  REPO_CACHE_DIR: optionalEnv(
    "REPO_CACHE_DIR",
    path.resolve(__dirname, "../repo-cache/starpilot")
  ),

  SYNC_CRON: optionalEnv("SYNC_CRON", "0 * * * *"),
  MEMORY_REFRESH_CRON: optionalEnv("MEMORY_REFRESH_CRON", "0 4 * * *"),
  ANSWER_TIMEOUT_SECONDS: parseInt(
    optionalEnv("ANSWER_TIMEOUT_SECONDS", "90"),
    10
  ),

  ALLOWED_CHANNEL_IDS: validateChannelIds(
    optionalEnv("ALLOWED_CHANNEL_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ),
} as const;

export function validateConfig(): void {
  if (!config.LLM_MODEL) {
    throw new Error("[config] LLM_MODEL cannot be empty");
  }
  if (config.ANSWER_TIMEOUT_SECONDS < 10 || config.ANSWER_TIMEOUT_SECONDS > 300) {
    throw new Error("[config] ANSWER_TIMEOUT_SECONDS must be between 10 and 300");
  }
  console.log("[config] All configuration validated");
}
