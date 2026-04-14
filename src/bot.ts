import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
  Events,
  ActivityType,
} from "discord.js";
import { config } from "./config.js";
import { askAboutRepo, type ConversationTurn } from "./agent.js";
import { getRepoCacheDir } from "./repoSync.js";
import { buildMemoryContext, extractAndUpdateMemory } from "./memory.js";
import { RateLimiter, createRateLimiterCleanup } from "./utils/rateLimiter.js";
import { Semaphore } from "./utils/semaphore.js";
import { chunkAnswer } from "./utils/chunking.js";

const EMOJI_SEEN = "👀";
const EMOJI_DONE = "✅";
const EMOJI_ERROR = "❌";
const MAX_HISTORY_DEPTH = 4;
const MAX_CONCURRENT = 2;

const rateLimiter = new RateLimiter();
const rateLimitCleanup = createRateLimiterCleanup(rateLimiter);
const agentSemaphore = new Semaphore(MAX_CONCURRENT);

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

const stripMentions = (text: string) => text.replace(/<@!?\d+>/g, "").trim();

const sanitizeThreadName = (text: string): string => {
  const cleaned = text
    .replace(/[^\w\s\-.,!?()[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.substring(0, 50) || "Codebase Question";
};

const isAllowedChannel = (id: string) =>
  config.ALLOWED_CHANNEL_IDS.length === 0 || config.ALLOWED_CHANNEL_IDS.includes(id);



async function removeReaction(message: Message, emoji: string) {
  if (client.user) {
    await message.reactions.cache.get(emoji)?.users.remove(client.user.id).catch(() => void 0);
  }
}

/** Recursively gathers reply history up to MAX_HISTORY_DEPTH */
async function buildConversationHistory(message: Message): Promise<ConversationTurn[]> {
  if (!client.user) return [];

  const turns: ConversationTurn[] = [];

  if (message.channel.isThread()) {
    try {
      const msgs = await message.channel.messages.fetch({ limit: 20, before: message.id });
      const arr = Array.from(msgs.values());

      let currentBotChunks: string[] = [];
      let currentUserChunks: string[] = [];

      for (const msg of arr) {
        if (turns.length >= MAX_HISTORY_DEPTH) break;

        if (msg.author.id === client.user.id) {
          if (currentUserChunks.length > 0) {
            turns.unshift({
              question: currentUserChunks.reverse().join('\n'),
              answer: currentBotChunks.reverse().join('\n'),
            });
            currentBotChunks = [];
            currentUserChunks = [];
          }
          currentBotChunks.push(msg.content);
        } else {
          currentUserChunks.push(stripMentions(msg.content));
        }
      }

      if (currentBotChunks.length > 0) {
        if (currentUserChunks.length > 0) {
          turns.unshift({
            question: currentUserChunks.reverse().join('\n'),
            answer: currentBotChunks.reverse().join('\n'),
          });
        } else {
          try {
            const starterMessage = await message.channel.fetchStarterMessage();
            if (starterMessage) {
              turns.unshift({
                question: stripMentions(starterMessage.content),
                answer: currentBotChunks.reverse().join('\n')
              });
            }
          } catch (e) {
            console.warn("[bot] Failed to fetch starter message:", e);
          }
        }
      }

      return turns;
    } catch (err) {
      console.error("[bot] Thread history fetch error:", err);
    }
  }

  let ref: typeof message.reference | undefined = message.reference;

  while (ref?.messageId && turns.length < MAX_HISTORY_DEPTH) {
    const botMsg: Message | null = await message.channel.messages.fetch(ref.messageId).catch(() => null);
    if (botMsg?.author.id !== client.user.id) break;

    const answer = botMsg.content;
    if (!answer || !botMsg.reference?.messageId) break;

    const userMsg: Message | null = await message.channel.messages.fetch(botMsg.reference.messageId).catch(() => null);
    const question = userMsg ? stripMentions(userMsg.content) : "";
    if (!question) break;

    turns.unshift({ question, answer });
    ref = userMsg?.reference;
  }

  return turns;
}

/** Handles LLM interaction and response delivery */
async function handleQuestion(
  message: Message,
  botName: string,
  question: string,
  memoryContext: string,
  history: ConversationTurn[]
) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timeout")),
      config.ANSWER_TIMEOUT_SECONDS * 1000
    );
  });

  const resetTimer = () => timer?.refresh();

  try {
    const answer = await Promise.race([
      askAboutRepo(botName, question, getRepoCacheDir(), memoryContext, history, resetTimer),
      timeout,
    ]);
    clearTimeout(timer);

    const chunks = chunkAnswer(answer);

    let threadTarget: ThreadChannel | null = null;

    if (!message.channel.isThread()) {
      try {
        const threadName = sanitizeThreadName(question.split('\n')[0]);
        threadTarget = await message.startThread({
          name: threadName,
          autoArchiveDuration: 60,
        });
      } catch (err) {
        console.error("[bot] Failed to start thread:", err);
      }
    }

    let lastMsg: Message = threadTarget
      ? await threadTarget.send(chunks[0])
      : await message.reply(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
      lastMsg = await lastMsg.reply(chunks[i]);
    }

    await removeReaction(message, EMOJI_SEEN);
    await message.react(EMOJI_DONE).catch(() => void 0);
    return answer;
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.message === "timeout";
    console.error("[bot] handleQuestion error:", err);

    await message.reply(
      isTimeout
        ? `⏱️ That took too long (>${config.ANSWER_TIMEOUT_SECONDS}s). Try a more specific question.`
        : `❌ Something went wrong. Please try again.`
    );

    await removeReaction(message, EMOJI_SEEN);
    await message.react(EMOJI_ERROR).catch(() => void 0);
    return null;
  }
}

client.on(Events.MessageCreate, async (message: Message) => {
  if (
    message.author.bot ||
    !client.user ||
    !message.mentions.has(client.user) ||
    !isAllowedChannel(message.channelId)
  ) return;

  const question = stripMentions(message.content);
  const botName = message.guild?.members.me?.nickname || client.user.displayName || client.user.username || "StarBot";

  if (!question) {
    await message.reply(
      `Hey! Ask me anything about the StarPilot codebase.\n` +
      `Example: \`@${botName} what GM vehicles are supported?\`\n\n` +
      `💡 I will create a thread to answer your question. You can continue the conversation there!\n` +
      `🧠 I'll also pick up on things you mention about your setup and remember them.`
    );
    return;
  }

  if (!rateLimiter.tryAcquire(message.author.id)) {
    await message.reply(
      `⚠️ You're doing that too often. Please wait a minute before asking another question.`
    );
    return;
  }

  await message.react(EMOJI_SEEN).catch(() => void 0);

  const history = await buildConversationHistory(message);
  if (history.length) {
    console.log(`[bot] Resuming thread with ${history.length} prior turn(s) for ${message.author.username}`);
  }

  const memoryContext = await buildMemoryContext(message.author.id, message.author.username);

  await agentSemaphore.acquire();
  let answer: string | null;
  try {
    answer = await handleQuestion(message, botName, question, memoryContext, history);
  } finally {
    agentSemaphore.release();
  }

  if (answer) {
    extractAndUpdateMemory(message.author.id, question, answer).catch(console.error);
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  c.user.setActivity("StarPilot questions", { type: ActivityType.Listening });
});

export const isBotReady = () => client.isReady();
export const startBot = async () => client.login(config.DISCORD_TOKEN);
export const stopBot = async () => {
  clearInterval(rateLimitCleanup);
  await client.destroy();
};
