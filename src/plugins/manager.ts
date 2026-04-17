import { SlashCommandBuilder, type Interaction, type PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import fs from "fs";
import { PLUGINS_DIR, PLUGINS_TESTS_DIR, PLUGIN_MAX_RETRIES } from "../config.js";
import { generatePlugin } from "../agent.js";
import { createOrModifyPlugin, deletePlugin, getExistingPlugin } from "./pluginTool.js";

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

export const addCommand = {
  data: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a new capability (admin only)")
    .addStringOption(opt => 
      opt.setName("prompt")
        .setDescription("Describe what you want the capability to do")
        .setRequired(true)
    ),
  
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAdmin = await checkAdmin(interaction);
    if (!isAdmin) {
      await interaction.reply("❌ Only administrators can use this command.");
      return;
    }
    
    const prompt = interaction.options.getString("prompt");
    if (!prompt) {
      await interaction.reply("❌ No prompt provided.");
      return;
    }
    
    await interaction.deferReply();
    
    try {
      const name = extractName(prompt);
      const result = await handlePluginGeneration(prompt, name, false);
      await interaction.editReply(result);
    } catch (err) {
      console.error("[add] Error:", err);
      await interaction.editReply(`❌ Failed: ${err}`);
    }
  }
};

export const modifyCommand = {
  data: new SlashCommandBuilder()
    .setName("modify")
    .setDescription("Modify an existing capability (admin only)")
    .addStringOption(opt =>
      opt.setName("name")
        .setDescription("Capability to modify")
        .setRequired(true)
        .addChoices(...getPluginChoices())
    )
    .addStringOption(opt =>
      opt.setName("prompt")
        .setDescription("Describe changes")
        .setRequired(true)
    ),
  
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAdmin = await checkAdmin(interaction);
    if (!isAdmin) {
      await interaction.reply("❌ Only administrators can use this command.");
      return;
    }
    
    const name = interaction.options.getString("name");
    const prompt = interaction.options.getString("prompt");
    
    if (!name || !prompt) {
      await interaction.reply("❌ Missing name or prompt.");
      return;
    }
    
    if (!getExistingPlugin(name)) {
      await interaction.editReply(`❌ Plugin "${name}" not found.`);
      return;
    }
    
    await interaction.deferReply();
    
    try {
      const result = await handlePluginGeneration(prompt, name, true);
      await interaction.editReply(result);
    } catch (err) {
      console.error("[modify] Error:", err);
      await interaction.editReply(`❌ Failed: ${err}`);
    }
  }
};

export const deleteCommand = {
  data: new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete a capability (admin only)")
    .addStringOption(opt =>
      opt.setName("name")
        .setDescription("Capability to delete")
        .setRequired(true)
        .addChoices(...getPluginChoices())
    ),
  
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAdmin = await checkAdmin(interaction);
    if (!isAdmin) {
      await interaction.reply("❌ Only administrators can use this command.");
      return;
    }
    
    const name = interaction.options.getString("name");
    if (!name) {
      await interaction.reply("❌ No capability specified.");
      return;
    }
    
    await interaction.deferReply();
    
    try {
      const result = deletePlugin(name);
      await interaction.editReply(result);
    } catch (err) {
      console.error("[delete] Error:", err);
      await interaction.editReply(`❌ Failed: ${err}`);
    }
  }
};

async function handlePluginGeneration(prompt: string, name: string, existing: boolean): Promise<string> {
  const MAX_TRIES = PLUGIN_MAX_RETRIES;
  let lastError = "";
  
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const attemptPrefix = attempt > 1 ? `\n\nPrevious attempt failed:\n${lastError}\n\nFix the code.` : "";
    const fullPrompt = existing
      ? `Modify capability "${name}": ${prompt}.${attemptPrefix}`
      : `Create capability "${name}": ${prompt}.${attemptPrefix}`;
    
    const answer = await generatePlugin(fullPrompt);
    
    const codeMatch = answer.match(/```(?:javascript|js)?\s*(const \w+[\s\S]*?)```/);
    const testMatch = answer.match(/```(?:javascript|js)?\s*(const \w+[\s\S]*?process\.exit)```/);
    
    if (!codeMatch) {
      if (attempt >= MAX_TRIES) {
        return `❌ Could not extract plugin code after ${MAX_TRIES} attempts.\n\n${answer.slice(0, 500)}`;
      }
      lastError = `Could not extract code from response: ${answer.slice(0, 200)}`;
      continue;
    }
    
    const code = codeMatch[1];
    const testCode = testMatch ? testMatch[1] : generateBasicTest(name);
    
    const result = await createOrModifyPlugin(name, code, testCode, existing);
    
    if (result.includes("✅")) {
      return result;
    }
    
    lastError = result;
    
    if (attempt >= MAX_TRIES) {
      return `❌ Failed after ${MAX_TRIES} attempts.\n\n${lastError}`;
    }
  }
  
  return lastError;
}

function generateBasicTest(name: string): string {
  return `const plugin = require("../data/plugins/plugin-${name}.js");

async function test() {
  const mock = { reply: (m) => { console.log("REPLY:", m); }, deferReply: async () => {} };
  await plugin.command.execute(mock);
  console.log("TEST_PASSED");
}

test().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
`;
}

function extractName(prompt: string): string {
  const words = prompt.split(/\s+/);
  for (const word of words) {
    const cleaned = word.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (cleaned.length > 2 && cleaned.length < 20) {
      return cleaned;
    }
  }
  return "custom";
}

export async function registerPluginCommands(rest: any, appId: string): Promise<void> {
  const commands = [
    addCommand.data.toJSON(),
    modifyCommand.data.toJSON(),
    deleteCommand.data.toJSON(),
  ];
  
  await rest.put(
    `/applications/${appId}/commands`,
    { body: commands }
  );
}

export function getAllCommands(): Array<any> {
  return [addCommand, modifyCommand, deleteCommand];
}