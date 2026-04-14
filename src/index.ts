import "dotenv/config";
import cron from "node-cron";
import { initRepo, syncRepo } from "./repoSync.js";
import { startBot } from "./bot.js";
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
  cron.schedule(config.SYNC_CRON, async () => {
    console.log("[cron] Running scheduled repo sync...");
    await syncRepo();
  });

  // 3. Start the Discord bot
  console.log("[main] Starting Discord bot...");
  await startBot();
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
