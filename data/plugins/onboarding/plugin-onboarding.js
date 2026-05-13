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

function cfg(val, fallback) {
  return val !== undefined && val !== null && val !== "" ? val : fallback;
}

const kickTimers = new Map();

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export const events = {
  reactionAdd: async (client, reaction, user) => {
    if (user.bot) return;
    const config = loadConfig();
    if (!config || !config.tosMessageId) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    if (reaction.message.id !== config.tosMessageId) return;

    const emoji = reaction.emoji.name;
    const channelId = cfg(config.tosChannelId, reaction.message.channelId);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    if (emoji === "✅") {
      await reaction.users.remove(user.id).catch(() => {});

      const existingTimer = kickTimers.get(user.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        kickTimers.delete(user.id);
      }

      const btnId = `onb_${user.id}`;
      const button = new ButtonBuilder()
        .setCustomId(btnId)
        .setLabel("Complete Onboarding")
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(button);

      await channel.send({
        content: `<@${user.id}> Click below to complete onboarding:`,
        components: [row],
      }).catch(() => {});
    }

    if (emoji === "❌") {
      if (kickTimers.has(user.id)) return;

      const delayMs = (cfg(config.kickDelaySeconds, 60)) * 1000;
      await channel.send(
        `⚠️ <@${user.id}> will be kicked in ${delayMs / 1000}s. React ✅ to cancel.`,
      ).catch(() => {});

      const guildId = config.guildId;
      if (!guildId) return;

      const timer = setTimeout(async () => {
        kickTimers.delete(user.id);
        try {
          const guild = await client.guilds.fetch(guildId);
          const member = await guild.members.fetch(user.id);
          await member.kick("Declined terms of service");
          const ch = await client.channels.fetch(channelId);
          if (ch) {
            await ch.send(`👋 **${user.username}** was removed.`).catch(() => {});
          }
        } catch {
          /* member may have left or guild not accessible */
        }
      }, delayMs);

      kickTimers.set(user.id, timer);
    }
  },

  reactionRemove: async (client, reaction, user) => {
    if (user.bot) return;
    const config = loadConfig();
    if (!config || !config.tosMessageId) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    if (reaction.message.id !== config.tosMessageId) return;

    const emoji = reaction.emoji.name;
    if (emoji !== "❌") return;

    const timer = kickTimers.get(user.id);
    if (!timer) return;

    clearTimeout(timer);
    kickTimers.delete(user.id);

    const channelId = cfg(config.tosChannelId, reaction.message?.channelId);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send(`✅ Kick cancelled for **${user.username}**.`).catch(() => {});
    }
  },

  interactionCreate: async (client, interaction) => {
    const config = loadConfig();
    if (!config || !config.tosMessageId) return;

    if (interaction.isButton() && interaction.customId.startsWith("onb_")) {
      const targetUserId = interaction.customId.slice(4);
      if (interaction.user.id !== targetUserId) {
        await interaction.reply({ content: "This button is not for you.", ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`onm_${targetUserId}`)
        .setTitle("Vehicle Information");

      const makeInput = new TextInputBuilder()
        .setCustomId("onb_make")
        .setLabel("Car Make")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. Toyota")
        .setRequired(true)
        .setMaxLength(50);

      const yearInput = new TextInputBuilder()
        .setCustomId("onb_year")
        .setLabel("Car Year")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 2016")
        .setRequired(true)
        .setMaxLength(4);

      const modelInput = new TextInputBuilder()
        .setCustomId("onb_model")
        .setLabel("Car Model")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. Prius")
        .setRequired(true)
        .setMaxLength(50);

      modal.addComponents(
        new ActionRowBuilder().addComponents(makeInput),
        new ActionRowBuilder().addComponents(yearInput),
        new ActionRowBuilder().addComponents(modelInput),
      );

      await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("onm_")) {
      const targetUserId = interaction.customId.slice(4);
      if (interaction.user.id !== targetUserId) {
        await interaction.reply({ content: "This form is not for you.", ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const rawMake = interaction.fields.getTextInputValue("onb_make").trim();
      const rawYear = interaction.fields.getTextInputValue("onb_year").trim();
      const rawModel = interaction.fields.getTextInputValue("onb_model").trim();

      if (!rawMake || !rawYear || !rawModel) {
        await interaction.editReply({ content: "❌ All fields are required." });
        return;
      }

      const cleanMake = capitalize(rawMake);
      const cleanYear = rawYear.replace(/[^0-9]/g, "").slice(0, 4);
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
          content: "❌ Could not set nickname. Check bot permissions (Manage Nicknames).",
        });
        return;
      }

      let makeRole = guild.roles.cache.find(r => r.name === cleanMake);
      if (!makeRole) {
        try {
          makeRole = await guild.roles.create({
            name: cleanMake,
            reason: "Onboarding - car make role",
          });
        } catch {
          let otherRole = guild.roles.cache.find(r => r.name === "Other");
          if (!otherRole) {
            try {
              otherRole = await guild.roles.create({
                name: "Other",
                reason: "Onboarding - fallback role",
              });
            } catch {
              await interaction.editReply({ content: "❌ Could not create roles." });
              return;
            }
          }
          makeRole = otherRole;
        }
      }

      const verifiedRoleName = cfg(config.verifiedRoleName, "Verified");
      let verifiedRole = guild.roles.cache.find(r => r.name === verifiedRoleName);
      if (!verifiedRole) {
        try {
          verifiedRole = await guild.roles.create({
            name: verifiedRoleName,
            reason: "Onboarding - verified role",
          });
        } catch {
          await interaction.editReply({ content: "❌ Could not create verified role." });
          return;
        }
      }

      try {
        await member.roles.add([makeRole.id, verifiedRole.id]);
      } catch {
        await interaction.editReply({ content: "❌ Could not assign roles. Check bot permissions." });
        return;
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
