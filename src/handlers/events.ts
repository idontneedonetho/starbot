import { Client, Discord, Once, On, ArgsOf, Guard } from 'discordx';
import {
  Events,
  ButtonStyle,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
} from 'discord.js';
import { readFileSync } from 'fs';
import { loadConfig } from '../config.js';
import { fetchWikiPages } from '../wiki/fetcher.js';
import { buildIndex } from '../wiki/indexer.js';
import { setIndex, setInitFailed, getInitStatus, getIndex } from '../wiki/wiki.js';
import { autoSearchWiki, formatWikiResults } from '../wiki/searcher.js';
import { WikiRateLimit } from './guards.js';

const BLURPLE = 0x5865f2;

function getCommitHash(): string | null {
  try {
    const head = readFileSync('.git/HEAD', 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = '.git/' + head.slice(5);
      return readFileSync(refPath, 'utf-8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return null;
  }
}

@Discord()
export class BotEvents {
  @Once({ event: Events.ClientReady })
  async ready([client]: ArgsOf<Events.ClientReady>) {
    const config = loadConfig();

    console.log(`Logged in as ${client.user!.tag}`);

    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error(`Guild ${config.guildId} not found`);
      return;
    }

    await this.ensureButtonMessage(
      guild, config.identificationChannelId,
      'Set Nickname & Vehicle', 'set_identity',
      ButtonStyle.Primary, '🎭',
      'Welcome to **StarPilot Server**! To gain access to the rest of the community, please set your server nickname and register your primary vehicle.\n\nYou can click this button at any time to update your vehicle or name in the future.',
    ).catch(err => console.error('Failed to set up identification button:', err));

    await this.ensureButtonMessage(
      guild, config.reportButtonChannelId,
      'Submit a Report', 'submit_report',
      ButtonStyle.Success, '🐛',
      '### Submit a Report\n\nEncountered an issue with navigation? Have an idea for a new feature? Let us know!\n\n> **Bug reports** require a **Route ID** — visible only to **server admins**',
    ).catch(err => console.error('Failed to set up report button:', err));

    // Initialize wiki search
    try {
      const wikiPages = await fetchWikiPages(config.wikiRepo, config.wikiCacheDir);
      if (wikiPages.length > 0) {
        const idx = await buildIndex(wikiPages, config.wikiCacheDir);
        setIndex(idx);
        console.log(`Wiki initialized with ${wikiPages.length} pages`);
      } else {
        console.log('Wiki fetch returned no pages');
        setInitFailed();
      }
    } catch (err) {
      console.error('Failed to initialize wiki:', err);
      setInitFailed();
    }

    const status = getInitStatus();
    console.log(`Wiki status: ${status}`);
    console.log('StarPilot bot is ready');

    const commitHash = getCommitHash();
    if (commitHash) {
      client.user!.setActivity({ name: commitHash, type: ActivityType.Watching });
    }
  }

  @On({ event: Events.InteractionCreate })
  async interactionCreate([interaction]: ArgsOf<Events.InteractionCreate>) {
    const client = interaction.client as Client;
    client.executeInteraction(interaction);
  }

  @On({ event: Events.MessageCreate })
  @Guard(WikiRateLimit)
  async messageCreate([message]: ArgsOf<Events.MessageCreate>) {
    const query = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!query) {
      await message.reply('Mention me with a question to search the wiki.');
      return;
    }

    const index = getIndex();
    if (!index) {
      const status = getInitStatus();
      if (status === 'failed') {
        await message.reply('Wiki search is currently unavailable (initialization failed). Please try again later.');
      } else if (status === 'not_started') {
        await message.reply('Wiki search is still loading. Please try again in a moment.');
      } else {
        await message.reply('Wiki search is not available right now.');
      }
      return;
    }

    const reactionEmoji = '⏳';
    let reactionAdded = false;
    try {
      await message.react(reactionEmoji);
      reactionAdded = true;
    } catch (err) { console.warn('[events] Failed to add reaction:', err); }

    try {
      const results = await autoSearchWiki(index, query);
      if (results.length > 0) {
        const embed = new EmbedBuilder()
          .setTitle('📖 Wiki Results')
          .setDescription(formatWikiResults(results))
          .setColor(BLURPLE)
          .setTimestamp();
        await message.reply({ embeds: [embed] });
      } else {
        await message.reply("I couldn't find a relevant wiki page.");
      }
    } catch (err) {
      console.error('Wiki search error:', err);
      await message.reply('Something went wrong while searching the wiki.');
    } finally {
      if (reactionAdded) {
        try {
          const reaction = message.reactions.cache.get(reactionEmoji);
          if (reaction) await reaction.users.remove(message.client.user!.id);
        } catch (err) { console.warn('[events] Failed to remove reaction:', err); }
      }
    }
  }

  private async ensureButtonMessage(
    guild: import('discord.js').Guild,
    channelId: string, label: string, customId: string,
    style: ButtonStyle, emoji: string, content?: string,
  ) {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.error(`Channel ${channelId} not found or not text-based`);
      return;
    }

    try {
      const { items } = await channel.messages.fetchPins();
      const existing = items.find(
        ({ message: m }) => m.author.id === guild.client.user!.id && m.components.length > 0,
      );
      if (existing) return;
    } catch (err) { console.warn('[events] Failed to fetch pinned messages:', err); }

    const message = await channel.send({
      content,
      components: [this.buttonRow(label, customId, style, emoji)],
    });
    await message.pin().catch(err => console.error('Failed to pin identification button:', err));
  }

  private buttonRow(label: string, customId: string, style: ButtonStyle, emoji: string) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setEmoji(emoji),
    );
  }
}
