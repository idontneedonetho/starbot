import { type GuardFunction, ArgsOf } from 'discordx';
import { Events } from 'discord.js';

const WIKI_COOLDOWN_MS = 10_000;
const wikiCooldowns = new Map<string, number>();

export const WikiRateLimit: GuardFunction<
  ArgsOf<Events.MessageCreate>
> = async ([message], client, next) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user!.id)) return;

  const now = Date.now();
  const lastUsed = wikiCooldowns.get(message.author.id) ?? 0;
  if (now - lastUsed < WIKI_COOLDOWN_MS) {
    const remaining = Math.ceil((WIKI_COOLDOWN_MS - (now - lastUsed)) / 1000);
    await message.reply(`Please wait ${remaining}s before searching again.`);
    return;
  }
  wikiCooldowns.set(message.author.id, now);

  if (wikiCooldowns.size > 1000) {
    const cutoff = now - WIKI_COOLDOWN_MS * 2;
    for (const [userId, timestamp] of wikiCooldowns) {
      if (timestamp < cutoff) wikiCooldowns.delete(userId);
    }
  }

  await next();
};
