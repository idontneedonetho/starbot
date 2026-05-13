import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function cfg(val, fallback) {
  return val !== undefined && val !== null && val !== "" ? val : fallback;
}

const kickTimers = new Map();
let botClient = null;
let sendingLock = false;
let watcherInitialized = false;

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

async function sendTosMessage(client, config) {
  if (sendingLock) return;
  sendingLock = true;
  try {
    const channel = await client.channels.fetch(config.tosChannelId);

    const agree = new ButtonBuilder()
      .setCustomId("onb_agree")
      .setLabel("I Agree")
      .setStyle(ButtonStyle.Success);

    const decline = new ButtonBuilder()
      .setCustomId("onb_decline")
      .setLabel("I Decline")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(agree, decline);

    const msg = await channel.send({
      content: "Click **I Agree** to accept the terms and begin onboarding:",
      components: [row],
    });

    config.tosMessageId = msg.id;
    saveConfig(config);
  } catch (err) {
    console.error("[onboarding] Failed to send TOS message:", err);
  } finally {
    sendingLock = false;
  }
}

export const events = {
  ready: async (client) => {
    botClient = client;

    if (!watcherInitialized) {
      watcherInitialized = true;
      fs.watchFile(CONFIG_PATH, { interval: 3000 }, async () => {
        if (!botClient) return;
        const cfg = loadConfig();
        if (!cfg || !cfg.tosChannelId || cfg.tosMessageId) return;
        await sendTosMessage(botClient, cfg);
      });
    }

    const config = loadConfig();
    if (!config || !config.tosChannelId) return;

    if (config.tosMessageId) {
      try {
        const channel = await client.channels.fetch(config.tosChannelId);
        await channel.messages.fetch(config.tosMessageId);
        return;
      } catch {
        // message deleted or channel gone — fall through to re-send
      }
    }

    await sendTosMessage(client, config);
  },

  messageDelete: async (client, message) => {
    const config = loadConfig();
    if (!config || !config.tosChannelId || !config.tosMessageId) return;
    if (message.id !== config.tosMessageId) return;

    config.tosMessageId = "";
    saveConfig(config);

    await sendTosMessage(client, config);
  },

  interactionCreate: async (client, interaction) => {
    const config = loadConfig();
    if (!config || !config.tosChannelId) return;

    if (interaction.isButton()) {
      const existingTimer = kickTimers.get(interaction.user.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        kickTimers.delete(interaction.user.id);
      }

      if (interaction.customId === "onb_agree") {
        if (!interaction.member || !interaction.guild) {
          await interaction.reply({ content: "Cannot verify outside a server.", flags: MessageFlags.Ephemeral });
          return;
        }

        let member;
        try {
          member = await interaction.guild.members.fetch(interaction.user.id);
        } catch {
          await interaction.reply({ content: "Could not find your member profile.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (member.roles.cache.some(r => r.id !== interaction.guild.roles.everyone.id)) {
          await interaction.reply({ content: "You're already verified!", flags: MessageFlags.Ephemeral });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`onm_${interaction.user.id}`)
          .setTitle("Vehicle Information");

        const yearInput = new TextInputBuilder()
          .setCustomId("onb_year")
          .setLabel("Car Year")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 2016")
          .setRequired(true)
          .setMaxLength(4);

        const makeInput = new TextInputBuilder()
          .setCustomId("onb_make")
          .setLabel("Car Make")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Toyota")
          .setRequired(true)
          .setMaxLength(50);

        const modelInput = new TextInputBuilder()
          .setCustomId("onb_model")
          .setLabel("Car Model")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Prius")
          .setRequired(true)
          .setMaxLength(50);

        modal.addComponents(
          new ActionRowBuilder().addComponents(yearInput),
          new ActionRowBuilder().addComponents(makeInput),
          new ActionRowBuilder().addComponents(modelInput),
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "onb_decline") {
        const delayMs = (cfg(config.kickDelaySeconds, 60)) * 1000;
        await interaction.reply({
          content: `⚠️ You'll be kicked in ${delayMs / 1000}s. Click **I Agree** to cancel.`,
          flags: MessageFlags.Ephemeral,
        });

        const guildId = config.guildId;
        if (!guildId) return;

        const timer = setTimeout(async () => {
          kickTimers.delete(interaction.user.id);
          try {
            const guild = await client.guilds.fetch(guildId);
            const member = await guild.members.fetch(interaction.user.id);
            await member.kick("Declined terms of service");
            const channel = await client.channels.fetch(config.tosChannelId);
            if (channel) {
              await channel.send(`👋 **${interaction.user.username}** was removed.`).catch(() => {});
            }
          } catch {
            /* member may have left or guild not accessible */
          }
        }, delayMs);

        kickTimers.set(interaction.user.id, timer);
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("onm_")) {
      const targetUserId = interaction.customId.slice(4);
      if (interaction.user.id !== targetUserId) {
        await interaction.reply({ content: "This form is not for you.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const rawYear = interaction.fields.getTextInputValue("onb_year").trim();
      const rawMake = interaction.fields.getTextInputValue("onb_make").trim();
      const rawModel = interaction.fields.getTextInputValue("onb_model").trim();

      if (!rawYear || !rawMake || !rawModel) {
        await interaction.editReply({ content: "❌ All fields are required." });
        return;
      }

      const cleanYear = rawYear.replace(/[^0-9]/g, "").slice(0, 4);
      const cleanMake = capitalize(rawMake);
      const cleanModel = rawModel
        .split(/\s+/)
        .map(w => capitalize(w))
        .join(" ");

      if (cleanYear.length !== 4 || !cleanMake || !cleanModel) {
        await interaction.editReply({
          content: "❌ Invalid input. Make sure year is 4 digits, and make/model are not empty.",
        });
        return;
      }

      const shortYear = cleanYear.slice(2);
      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply({ content: "❌ Could not find server." });
        return;
      }

      let member;
      try {
        member = await guild.members.fetch(interaction.user.id);
      } catch {
        await interaction.editReply({ content: "❌ Could not find your member profile." });
        return;
      }

      const displayName = interaction.user.displayName;
      const nickname = `${displayName} ('${shortYear} ${cleanModel})`;
      try {
        await member.setNickname(nickname);
      } catch {
        await interaction.editReply({
          content: "❌ Could not set nickname. The bot needs a role higher than yours with Manage Nicknames permission.",
        });
        return;
      }

      let makeRole = guild.roles.cache.find(r => r.name === cleanMake);
      if (!makeRole && client.singleTurnLlm) {
        const roleNames = guild.roles.cache
          .filter(r => r.name !== "@everyone")
          .map(r => r.name);
        const prompt = `Given these Discord role names:\n${roleNames.join("\n")}\n\nWhich role is the best match for car make "${cleanMake}"? Reply with ONLY the role name or "none".`;
        try {
          const result = await client.singleTurnLlm("You match car makes to Discord role names.", prompt);
          const match = result.replace(/["`*]/g, "").trim();
          if (match.toLowerCase() !== "none") {
            makeRole = guild.roles.cache.find(r => r.name === match) || null;
          }
        } catch {
          // LLM failed, fall through to Other fallback
        }
      }
      makeRole ??= guild.roles.cache.find(r => r.name === "Other") || null;

      if (makeRole) {
        try {
          await member.roles.add([makeRole.id]);
        } catch {
          await interaction.editReply({ content: "❌ Could not assign role. Check bot permissions." });
          return;
        }
      }

      const channelId = cfg(config.tosChannelId, null);
      if (channelId) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(
            `✅ **${displayName}** has completed onboarding — drives a ${cleanYear} ${cleanMake} ${cleanModel}`,
          ).catch(() => {});
        }
      }

      await interaction.editReply({
        content:
          `✅ Onboarding complete!\n` +
          `Nickname: \`${nickname}\`\n` +
          `Role: ${cleanMake}\n` +
          `You now have access to the server.`,
      });
    }
  },
};
