import { REST, Routes } from "discord.js";
import { config } from "../src/config.js";
import { getAllCommands } from "../src/plugins/manager.js";

if (!config.DISCORD_CLIENT_ID) {
  console.error("[register] DISCORD_CLIENT_ID is not set in your .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
const commands = getAllCommands().map(c => c.data.toJSON());

console.log(`[register] Registering ${commands.length} command(s) globally...`);

await rest.put(
  Routes.applicationCommands(config.DISCORD_CLIENT_ID),
  { body: commands },
);

console.log("[register] Done.");
