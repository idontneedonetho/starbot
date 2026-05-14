import {
  Client,
  GatewayIntentBits,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type Guild,
  MessageFlags,
} from 'discord.js';
import { loadConfig } from './config.js';
import { loadData, saveData } from './data.js';
import { handleIdentityButton, handleIdentitySubmit } from './handlers/identification.js';
import { handleReportButton, handleReportTypeSelect, handleBugSubmit, handleFeedbackSubmit } from './handlers/report.js';

const config = loadConfig();
const data = loadData();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

async function ensureButtonMessage(
  guild: Guild,
  channelId: string,
  dataKey: 'identificationMessageId' | 'reportMessageId',
  label: string,
  customId: string,
  style: ButtonStyle,
  emoji: string,
  content?: string,
) {
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    console.error(`Channel ${channelId} not found or not text-based`);
    return;
  }

  const storedId = data[dataKey];

  if (storedId) {
    try {
      const message = await channel.messages.fetch(storedId);
      if (message.author.id === client.user!.id) {
        return;
      }
    } catch {
      // deleted — create new below
    }
  }

  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setEmoji(emoji);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  const message = await channel.send({ content, components: [row] });
  data[dataKey] = message.id;
  saveData(data);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user!.tag}`);

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    console.error(`Guild ${config.guildId} not found`);
    return;
  }

  await ensureButtonMessage(
    guild,
    config.identificationChannelId,
    'identificationMessageId',
    'Set Nickname & Vehicle',
    'set_identity',
    ButtonStyle.Primary,
    '🎭',
    [
      'Welcome to **StarPilot Server**! To gain access to the rest of the community, please set your server nickname and register your primary vehicle.',
      'You can click this button at any time to update your vehicle or name in the future.',
    ].join('\n\n'),
  ).catch(err => console.error('Failed to set up identification button:', err));

  await ensureButtonMessage(
    guild,
    config.reportChannelId,
    'reportMessageId',
    'Submit a Report',
    'submit_report',
    ButtonStyle.Success,
    '🐛',
    [
      'Encountered an issue with navigation? Have an idea for a new feature? Let us know!',
      'Click the button below to fill out a structured report. Bugs will require a Route ID.',
    ].join('\n\n'),
  ).catch(err => console.error('Failed to set up report button:', err));

  console.log('StarPilot bot is ready');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
      return;
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function handleButton(interaction: ButtonInteraction) {
  switch (interaction.customId) {
    case 'set_identity':
      await handleIdentityButton(interaction);
      break;
    case 'submit_report':
      await handleReportButton(interaction);
      break;
    default:
      await interaction.reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral });
  }
}

async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  switch (interaction.customId) {
    case 'report_type_select':
      await handleReportTypeSelect(interaction);
      break;
    default:
      await interaction.reply({ content: 'Unknown selection.', flags: MessageFlags.Ephemeral });
  }
}

async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  switch (interaction.customId) {
    case 'identity_modal':
      await handleIdentitySubmit(interaction);
      break;
    case 'bug_modal':
      await handleBugSubmit(interaction);
      break;
    case 'feedback_modal':
      await handleFeedbackSubmit(interaction, 'feedback');
      break;
    case 'feature_modal':
      await handleFeedbackSubmit(interaction, 'feature');
      break;
    default:
      await interaction.reply({ content: 'Unknown modal submission.', flags: MessageFlags.Ephemeral });
  }
}

client.login(config.token);

function shutdown() {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
