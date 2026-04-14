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

export const config = {
  // Discord
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: requireEnv("DISCORD_CLIENT_ID"),

  // LLM provider (used by pi-coding-agent AuthStorage)
  LLM_PROVIDER: optionalEnv("LLM_PROVIDER", "anthropic"),
  LLM_API_KEY: requireEnv("LLM_API_KEY"),

  // Optional: specific model ID. If omitted, pi picks first available.
  LLM_MODEL: optionalEnv("LLM_MODEL", "claude-sonnet-4-5"),

  // Repo settings
  STARPILOT_REPO_URL: optionalEnv(
    "STARPILOT_REPO_URL",
    "https://github.com/firestar5683/starpilot"
  ),
  STARPILOT_BRANCH: optionalEnv("STARPILOT_BRANCH", "StarPilot"),
  REPO_CACHE_DIR: optionalEnv(
    "REPO_CACHE_DIR",
    path.resolve(__dirname, "../repo-cache/starpilot")
  ),

  // Schedule for git pull (default: every hour)
  SYNC_CRON: optionalEnv("SYNC_CRON", "0 * * * *"),

  // Maximum seconds to wait for an agent answer before timing out
  ANSWER_TIMEOUT_SECONDS: parseInt(
    optionalEnv("ANSWER_TIMEOUT_SECONDS", "90"),
    10
  ),

  // Optional: restrict bot to specific Discord channel IDs (comma-separated).
  // If empty, the bot responds in all channels.
  ALLOWED_CHANNEL_IDS: optionalEnv("ALLOWED_CHANNEL_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
} as const;
