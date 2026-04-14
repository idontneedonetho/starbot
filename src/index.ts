import http from "http";
import cron from "node-cron";
import { initRepo, syncRepo, isRepoReady, getLastSyncTime } from "./repoSync.js";
import { startBot, stopBot, isBotReady } from "./bot.js";
import { config, validateConfig } from "./config.js";

function getHealthStatus(): { ok: boolean; status: string } {
  const botReady = isBotReady();
  const repoReady = isRepoReady();
  
  if (!botReady) return { ok: false, status: "bot not ready" };
  if (!repoReady) return { ok: false, status: "repo not ready" };
  
  return { ok: true, status: "healthy" };
}

async function main(): Promise<void> {
  console.log("=== StarBot starting up ===");

  try {
    validateConfig();
    await initRepo();
  } catch (err) {
    console.error("[index] Failed to initialise:", err);
    process.exit(1);
  }

  console.log(`[index] Scheduling repo sync: "${config.SYNC_CRON}"`);
  const syncTask = cron.schedule(config.SYNC_CRON, async () => {
    console.log("[index] Running scheduled repo sync...");
    await syncRepo();
  });

  console.log("[index] Starting Discord bot...");
  await startBot();

  const healthServer = http.createServer((req, res) => {
    const health = getHealthStatus();
    if (req.url === "/health") {
      res.writeHead(health.ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        ...health,
        lastSync: getLastSyncTime()?.toISOString() ?? null
      }));
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  healthServer.listen(3000, () => console.log("[index] Health endpoint on :3000/health"));

  const shutdown = async (signal: string) => {
    console.log(`\n[index] Received ${signal}. Shutting down gracefully...`);
    healthServer.close();
    syncTask.stop();
    await stopBot();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[index] Fatal error:", err);
  process.exit(1);
});
