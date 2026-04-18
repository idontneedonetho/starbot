import { SlashCommandBuilder, type Interaction, type PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import fs from "fs";
import { PLUGINS_DIR } from "../config.js";
import { createPlugin } from "../agent.js";
import { loadPlugin, registerCommand, commands } from "./loader.js";

const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS
  ? process.env.ADMIN_USER_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : [];
const adminUserSet = new Set(ADMIN_USER_IDS);

async function checkAdmin(interaction: Interaction): Promise<boolean> {
  const userId = interaction.user?.id;
  if (!userId) return false;
  
  if (adminUserSet.has(userId)) return true;
  
  const member = interaction.member;
  if (!member) return false;
  
  const perms = member.permissions as unknown as PermissionsBitField;
  return perms.has("Administrator");
}

export function getPluginChoices(): Array<{ name: string; value: string }> {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  
  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js") && f.startsWith("plugin-"));
  return files.map(f => ({
    name: f.replace("plugin-", "").replace(".js", ""),
    value: f.replace("plugin-", "").replace(".js", ""),
  }));
}

export const manageCommand = {
  data: new SlashCommandBuilder()
    .setName("manage")
    .setDescription("Manage plugins (admin only)")
    .addStringOption(opt =>
      opt.setName("prompt")
        .setDescription("What you want to do (e.g., 'create a ping command', 'delete this plugin', 'add a welcome message')")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("plugin")
        .setDescription("Existing plugin to modify")
        .setRequired(false)
        .addChoices(...getPluginChoices())
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

    let statusMessage = "🔄 Working...";
    await interaction.editReply(statusMessage);

    let lastUpdate = Date.now();
    let lastStatus = "";
    let lastAnswerLength = 0;

    const UPDATE_INTERVAL = 5000;

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
        }
      );

      if (result.includes("PLUGIN_ERROR:")) {
        const errorMsg = result.match(/PLUGIN_ERROR: (.+)/)?.[1] || "Unknown error";
        throw new Error(`Agent reported error: ${errorMsg}`);
      }

      if (!result.includes("PLUGIN_READY")) {
        console.warn("[manage] Agent did not confirm PLUGIN_READY, attempting to load anyway...");
      }

      const newFiles = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js") && f.startsWith("plugin-"));
      let loadedCount = 0;
      for (const file of newFiles) {
        try {
          await loadPlugin(`${PLUGINS_DIR}/${file}`);
          const name = file.replace("plugin-", "").replace(".js", "");
          const cmd = commands.get(name);
          if (cmd) {
            await registerCommand(name);
          }
          loadedCount++;
          console.log(`[manage] Loaded: ${file}`);
        } catch (err) {
          console.warn(`[manage] Failed to load ${file}:`, err);
        }
      }

      if (loadedCount === 0) {
        throw new Error("No plugins could be loaded");
      }

      await interaction.editReply(`✅ Done. (${loadedCount} plugin(s) loaded)`);
    } catch (err) {
      console.error("[manage] Agent error:", err);
      await interaction.editReply(`❌ Failed: ${err}`);
    }
  }
};

export function getAllCommands(): Array<any> {
  return [manageCommand];
}