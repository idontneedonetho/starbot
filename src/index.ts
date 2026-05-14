import {
  Client,
  GatewayIntentBits,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder,
  Events,
  ForumChannel,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type Message,
  type Guild,
  MessageFlags,
} from 'discord.js';
import { loadConfig } from './config.js';
import { loadData, saveData } from './data.js';
import { handleIdentityButton, handleIdentitySubmit } from './handlers/identification.js';
import { handleReportButton, handleReportTypeSelect, handleBugSubmit, handleFeedbackSubmit } from './handlers/report.js';
import { ensureWikiClone, readWikiPages } from './wiki/fetcher.js';
import { buildIndex } from './wiki/indexer.js';
import { setIndex, getIndex } from './wiki/wiki.js';
import { autoSearchWiki } from './wiki/searcher.js';

const config = loadConfig();
const data = loadData();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function buttonRow(label: string, customId: string, style: ButtonStyle, emoji: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setEmoji(emoji),
  );
}

async function ensureButtonMessage(
  guild: Guild,
  channelId: string,
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

  if (data.identificationMessageId) {
    try {
      const message = await channel.messages.fetch(data.identificationMessageId);
      if (message.author.id === client.user!.id) {
        return;
      }
    } catch {
      // deleted — create new below
    }
  }

  const message = await channel.send({ content, components: [buttonRow(label, customId, style, emoji)] });
  data.identificationMessageId = message.id;
  saveData(data);
}

async function ensureButtonThread(
  guild: Guild,
  forumId: string,
  threadName: string,
  label: string,
  customId: string,
  style: ButtonStyle,
  emoji: string,
  content?: string,
) {
  const forum = await guild.channels.fetch(forumId);
  if (!(forum instanceof ForumChannel)) {
    console.error(`Forum channel ${forumId} not found`);
    return;
  }

  if (data.reportThreadId) {
    try {
      const thread = await forum.threads.fetch(data.reportThreadId);
      if (thread && thread.ownerId === client.user!.id) {
        if (thread.archived) await thread.setArchived(false);
        return;
      }
    } catch {
      // deleted — create new below
    }
  }

  // Create forum post for the report button
  const row = buttonRow(label, customId, style, emoji);
  const raw = await client.rest.post(`/channels/${forum.id}/threads`, {
    body: {
      name: threadName,
      message: { content, components: [row.toJSON()] },
    },
  }) as { id: string };

  const thread = await forum.threads.fetch(raw.id);
  if (!thread) {
    console.error('Failed to resolve created thread');
    return;
  }

  // Lock thread so members can't reply in it
  await thread.setLocked(true).catch(err => console.error('Failed to lock report thread:', err));

  await thread.pin().catch(err => console.error('Failed to pin report thread:', err));

  data.reportThreadId = thread.id;
  saveData(data);
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user!.tag}`);

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    console.error(`Guild ${config.guildId} not found`);
    return;
  }

  await ensureButtonMessage(
    guild,
    config.identificationChannelId,
    'Set Nickname & Vehicle',
    'set_identity',
    ButtonStyle.Primary,
    '🎭',
    [
      'Welcome to **StarPilot Server**! To gain access to the rest of the community, please set your server nickname and register your primary vehicle.',
      'You can click this button at any time to update your vehicle or name in the future.',
    ].join('\n\n'),
  ).catch(err => console.error('Failed to set up identification button:', err));

  await ensureButtonThread(
    guild,
    config.forumChannelId,
    'Click Here to Submit a Report',
    'Submit a Report',
    'submit_report',
    ButtonStyle.Success,
    '🐛',
    [
      'Click the button below to submit a structured report. Bugs will require a Route ID.',
      'Encountered an issue with navigation? Have an idea for a new feature? Let us know!',
    ].join('\n\n'),
  ).catch(err => console.error('Failed to set up report button thread:', err));

  // Initialize wiki search
  try {
    await ensureWikiClone(config.wikiCloneUrl, config.wikiClonePath);
    const wikiPages = readWikiPages(config.wikiClonePath);
    if (wikiPages.length > 0) {
      const idx = await buildIndex(wikiPages, config.wikiClonePath);
      setIndex(idx);
      console.log(`Wiki initialized with ${wikiPages.length} pages`);
    } else {
      console.log('Wiki clone empty — no pages found');
    }
  } catch (err) {
    console.error('Failed to initialize wiki:', err);
  }

  console.log('StarPilot bot is ready');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(interaction);
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

async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  if (interaction.customId === 'identity_modal') {
    await handleIdentitySubmit(interaction);
    return;
  }

  switch (interaction.customId) {
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

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user!.id)) return;

  const query = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!query) return;

  const index = getIndex();
  if (!index) {
    await message.reply('Wiki search is not available right now.');
    return;
  }

  const reactionEmoji = '⏳';
  let reactionAdded = false;

  try {
    await message.react(reactionEmoji);
    reactionAdded = true;
  } catch {
    // Ignore if we can't add reactions (missing permissions, etc.)
  }

  try {
    const result = await autoSearchWiki(index, query);
    const finalText = result ?? "I couldn't find a relevant wiki page.";
    await message.reply(finalText);
  } catch (err) {
    console.error('Wiki search error:', err);
    await message.reply('Something went wrong while searching the wiki.');
  } finally {
    if (reactionAdded) {
      try {
        const reaction = message.reactions.cache.get(reactionEmoji);
        if (reaction) await reaction.users.remove(client.user!.id);
      } catch {
        // Ignore reaction cleanup failures
      }
    }
  }
});

client.login(config.token);

function shutdown() {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
