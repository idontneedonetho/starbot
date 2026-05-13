import { execSync } from "child_process";
import { SlashCommandBuilder, type Interaction, type PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import fs from "fs";
import path from "path";
import { PLUGINS_DIR, ADMIN_USER_IDS } from "../config.js";
import { createPlugin } from "../agent.js";
import { loadPlugin, unloadPlugin, syncDiscordCommands, commands } from "./loader.js";

const adminUserSet = new Set(ADMIN_USER_IDS);

function checkSyntax(filePath: string): boolean {
  try {
    execSync(`node -c ${JSON.stringify(filePath)}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function checkAdmin(interaction: Interaction): Promise<boolean> {
  const userId = interaction.user?.id;
  if (!userId) return false;

  if (adminUserSet.has(userId)) return true;

  const member = interaction.member;
  if (!member) return false;

  const perms = member.permissions as unknown as PermissionsBitField;
  return perms.has("Administrator");
}

interface CommandDef {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const manageCommand = {
  data: new SlashCommandBuilder()
    .setName("manage")
    .setDescription("Manage plugins (admin only)")
    .addStringOption(opt =>
      opt.setName("prompt")
        .setDescription("What you want to do (e.g., 'create a ping command', 'delete this plugin', 'add a welcome message')")
        .setRequired(true),
    )
    .addStringOption(opt =>
      opt.setName("plugin")
        .setDescription("Existing plugin name to modify (type the name)")
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAdmin = await checkAdmin(interaction);
    if (!isAdmin) {
      await interaction.reply("❌ Only administrators can use this command.");
      return;
    }

    const plugin = interaction.options.getString("plugin");
    const prompt = interaction.options.getString("prompt");

    if (!prompt) {
      await interaction.reply("❌ Provide a prompt describing what you want to do.");
      return;
    }

    await interaction.deferReply();
    await interaction.editReply("🔄 Working...");

    let lastUpdate = Date.now();
    let lastStatus = "";
    let lastAnswerLength = 0;
    const UPDATE_INTERVAL = 5000;

    // Snapshot existing plugin files so we only load newly created ones after the agent runs.
    const existingFiles = new Set(
      fs.existsSync(PLUGINS_DIR)
        ? fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js") && f.startsWith("plugin-"))
        : [],
    );

    try {
      const fullPrompt = plugin
        ? `Modify plugin "${plugin}": ${prompt}`
        : prompt;

      console.log(`[manage] Running agent in ${PLUGINS_DIR}`);
      console.log(`[manage] Prompt: ${fullPrompt.slice(0, 200)}...`);

      const result = await createPlugin(
        fullPrompt,
        PLUGINS_DIR,
        (text) => process.stdout.write(`[agent] ${text}`),
        () => {},
        undefined,
        (currentAnswer) => {
          const now = Date.now();
          const answerLength = currentAnswer.length;
          if (now - lastUpdate >= UPDATE_INTERVAL && answerLength !== lastAnswerLength) {
            lastUpdate = now;
            lastAnswerLength = answerLength;
            const snippet = currentAnswer.slice(-200).replace(/\n/g, " ");
            const newStatus = snippet.length > 100 ? `🔄 ${snippet.slice(0, 100)}...` : `🔄 ${snippet}`;
            if (newStatus !== lastStatus) {
              lastStatus = newStatus;
              interaction.editReply(newStatus).catch(() => {});
            }
          }
        },
      );

      if (result.includes("PLUGIN_ERROR:")) {
        const errorMsg = result.match(/PLUGIN_ERROR: (.+)/)?.[1] || "Unknown error";
        throw new Error(`Agent reported error: ${errorMsg}`);
      }

      if (!result.includes("PLUGIN_READY")) {
        console.warn("[manage] Agent did not confirm PLUGIN_READY, attempting to load anyway...");
      }

      let loadedCount = 0;

      let needsSync = false;

      // Reload a modified plugin (unload stale version first, then load the rewritten file).
      if (plugin) {
        const modifiedFile = `plugin-${plugin}.js`;
        const modifiedPath = path.join(PLUGINS_DIR, modifiedFile);
        if (fs.existsSync(modifiedPath)) {
          if (!checkSyntax(modifiedPath)) {
            console.warn(`[manage] Syntax check failed for ${modifiedFile}, skipping reload`);
          } else {
            try {
              unloadPlugin(plugin);
              await loadPlugin(modifiedPath);
              if (commands.get(plugin)) needsSync = true;
              loadedCount++;
              console.log(`[manage] Reloaded: ${modifiedFile}`);
            } catch (err) {
              console.warn(`[manage] Failed to reload ${modifiedFile}:`, err);
            }
          }
        }
      }

      // Load any brand-new plugin files the agent created.
      const newFiles = fs.existsSync(PLUGINS_DIR)
        ? fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js") && f.startsWith("plugin-") && !existingFiles.has(f))
        : [];

      for (const file of newFiles) {
        const pluginPath = path.join(PLUGINS_DIR, file);
        if (!checkSyntax(pluginPath)) {
          console.warn(`[manage] Syntax check failed for ${file}, skipping`);
          continue;
        }
        try {
          await loadPlugin(pluginPath);
          const name = file.replace(/^plugin-/, "").replace(/\.js$/, "");
          if (commands.get(name)) needsSync = true;
          loadedCount++;
          console.log(`[manage] Loaded: ${file}`);
        } catch (err) {
          console.warn(`[manage] Failed to load ${file}:`, err);
        }
      }

      // Sync Discord commands once after all plugins are loaded, not once per plugin.
      if (needsSync) {
        await syncDiscordCommands(getAllCommands());
      }

      if (loadedCount === 0 && (plugin || newFiles.length > 0)) {
        throw new Error("Plugin could not be loaded");
      }

      const summary = loadedCount > 0
        ? `✅ Done. (${loadedCount} plugin(s) loaded/reloaded)`
        : `✅ Done. (no plugin files created)`;
      await interaction.editReply(summary);
    } catch (err) {
      console.error("[manage] Agent error:", err);
      await interaction.editReply(`❌ Failed: ${err}`);
    }
  },
};

export function getAllCommands(): CommandDef[] {
  return [manageCommand as CommandDef];
}