import "dotenv/config";
import http from "http";
import cron from "node-cron";
import { initRepo, syncRepo } from "./repoSync.js";
import { startBot, stopBot, isBotReady } from "./bot.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("=== StarBot starting up ===");

  // 1. Clone or update the StarPilot repo
  try {
    await initRepo();
  } catch (err) {
    console.error("[main] Failed to initialise repo:", err);
    process.exit(1);
  }

  // 2. Schedule periodic git syncs
  console.log(`[main] Scheduling repo sync: "${config.SYNC_CRON}"`);
  const syncTask = cron.schedule(config.SYNC_CRON, async () => {
    console.log("[cron] Running scheduled repo sync...");
    await syncRepo();
  });

  // 3. Start the Discord bot
  console.log("[main] Starting Discord bot...");
  await startBot();

  // 4. Minimal health endpoint for Docker healthcheck
  const healthServer = http.createServer((_, res) => {
    const ok = isBotReady();
    res.writeHead(ok ? 200 : 503);
    res.end(ok ? "ok" : "not ready");
  });
  healthServer.listen(3000, () => console.log("[main] Health endpoint on :3000"));

  // 5. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n[main] Received ${signal}. Shutting down gracefully...`);
    healthServer.close();
    syncTask.stop();
    await stopBot();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
