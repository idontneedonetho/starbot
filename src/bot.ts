import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  Events,
  ActivityType,
  EmbedBuilder,
} from "discord.js";
import { config } from "./config.js";
import { askAboutRepo, type ConversationTurn } from "./agent.js";
import { getRepoCacheDir } from "./repoSync.js";
import { buildMemoryContext, extractAndUpdateMemory } from "./memory.js";

// ---------------------------------------------------------------------------
// Discord client setup
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMOJI_SEEN  = "👀";
const EMOJI_DONE  = "✅";
const EMOJI_ERROR = "❌";

/** Maximum number of prior exchanges to include from a reply chain. */
const MAX_HISTORY_DEPTH = 4;

function chunkAnswer(text: string, maxLen = 4096): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const idx = remaining.lastIndexOf("\n", maxLen);
    const split = idx > maxLen / 2 ? idx : maxLen;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isAllowedChannel(channelId: string): boolean {
  return (
    config.ALLOWED_CHANNEL_IDS.length === 0 ||
    config.ALLOWED_CHANNEL_IDS.includes(channelId)
  );
}

function buildAnswerEmbed(question: string, answer: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: "StarBot — StarPilot Q&A" })
    .setTitle(`❓ ${question.length > 200 ? question.slice(0, 197) + "…" : question}`)
    .setDescription(answer.length > 4096 ? answer.slice(0, 4093) + "…" : answer)
    .setFooter({ text: "Powered by pi coding agent + StarPilot source" })
    .setTimestamp();
}

async function removeReaction(message: Message, emoji: string): Promise<void> {
  if (!client.user) return;
  await message.reactions.cache
    .get(emoji)
    ?.users.remove(client.user.id)
    .catch(() => void 0);
}

// ---------------------------------------------------------------------------
// Reply chain walker
// ---------------------------------------------------------------------------

/**
 * Walks up the Discord reply chain to build a conversation history array.
 *
 * Structure of a StarBot thread:
 *   User message M1   (the question, may or may not reference an earlier bot reply)
 *   Bot reply M2      (references M1 — contains the answer in an embed)
 *   User reply M3     (references M2 — the follow-up question)  ← current
 *
 * We walk: current → M2 (bot answer) → M1 (user question) → repeat up the chain.
 * Returns turns in chronological order (oldest first).
 */
async function buildConversationHistory(
  message: Message
): Promise<ConversationTurn[]> {
  if (!client.user) return [];

  const turns: ConversationTurn[] = [];
  let ref = message.reference;

  while (ref?.messageId && turns.length < MAX_HISTORY_DEPTH) {
    // Step 1: Fetch the referenced message (should be the bot's answer)
    let botMsg: Message;
    try {
      botMsg = await message.channel.messages.fetch(ref.messageId);
    } catch {
      break; // message deleted or inaccessible
    }

    if (botMsg.author.id !== client.user.id) break; // not our message

    // Extract the answer text from the embed
    const answer = botMsg.embeds[0]?.description;
    if (!answer) break; // not a proper answer embed (e.g. the "Thinking..." placeholder)

    // Step 2: The bot's message should reference the user's question
    if (!botMsg.reference?.messageId) break;

    let userMsg: Message;
    try {
      userMsg = await message.channel.messages.fetch(botMsg.reference.messageId);
    } catch {
      break;
    }

    // Extract the question text (strip any @mentions)
    const question = userMsg.content.replace(/<@!?\d+>/g, "").trim();
    if (!question) break;

    // Prepend so the array ends up oldest-first after the loop
    turns.unshift({ question, answer });

    // Walk up: the user's message might itself have been a reply to an earlier bot answer
    ref = userMsg.reference;
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Core Q&A handler
// ---------------------------------------------------------------------------

async function handleQuestion(
  message: Message,
  question: string,
  memoryContext: string,
  history: ConversationTurn[]
): Promise<string | null> {
  const repoCwd = getRepoCacheDir();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("timeout")),
      config.ANSWER_TIMEOUT_SECONDS * 1000
    )
  );

  const thinkingMsg = await message.reply("🤔 Thinking…");
  let answer: string | null = null;

  try {
    answer = await Promise.race([
      askAboutRepo(question, repoCwd, memoryContext, history),
      timeout,
    ]);

    const chunks = chunkAnswer(answer);
    await thinkingMsg.edit({ embeds: [buildAnswerEmbed(question, chunks[0])] });

    for (let i = 1; i < chunks.length; i++) {
      if (message.channel.isSendable()) {
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setDescription(chunks[i])
              .setFooter({ text: `(continued ${i + 1}/${chunks.length})` }),
          ],
        });
      }
    }

    await removeReaction(message, EMOJI_SEEN);
    await message.react(EMOJI_DONE).catch(() => void 0);
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.message === "timeout";
    console.error("[bot] handleQuestion error:", err);

    await thinkingMsg.edit(
      isTimeout
        ? `⏱️ That took too long (>${config.ANSWER_TIMEOUT_SECONDS}s). Try a more specific question.`
        : `❌ Something went wrong. Please try again.`
    );

    await removeReaction(message, EMOJI_SEEN);
    await message.react(EMOJI_ERROR).catch(() => void 0);
  }

  return answer;
}

// ---------------------------------------------------------------------------
// Message handler: @mention only
// ---------------------------------------------------------------------------

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!client.user) return;
  if (!message.mentions.has(client.user)) return;
  if (!isAllowedChannel(message.channelId)) return;

  const question = message.content.replace(/<@!?\d+>/g, "").trim();

  if (!question) {
    await message.reply(
      "Hey! Ask me anything about the StarPilot codebase.\n" +
      "Example: `@StarBot what GM vehicles are supported?`\n\n" +
      "💡 Reply to one of my answers to continue the conversation in context.\n" +
      "🧠 I'll also pick up on things you mention about your setup and remember them."
    );
    return;
  }

  // 👀 — acknowledge immediately
  await message.react(EMOJI_SEEN).catch(() => void 0);

  if (message.channel.isSendable()) {
    await message.channel.sendTyping().catch(() => void 0);
  }

  // Walk reply chain to build thread context (empty array if this is a fresh question)
  const history = await buildConversationHistory(message);
  if (history.length) {
    console.log(`[bot] Resuming thread with ${history.length} prior turn(s) for ${message.author.username}`);
  }

  const memoryContext = buildMemoryContext(message.author.id, message.author.username);
  const answer = await handleQuestion(message, question, memoryContext, history);

  // Background memory extraction — doesn't delay the reply
  if (answer) {
    extractAndUpdateMemory(message.author.id, question, answer).catch(console.error);
  }
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  c.user.setActivity("StarPilot questions", { type: ActivityType.Listening });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startBot(): Promise<void> {
  await client.login(config.DISCORD_TOKEN);
}
