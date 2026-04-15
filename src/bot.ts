import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
  Events,
  ActivityType,
} from "discord.js";
import { config, ALLOWED_CHANNEL_IDS, ANSWER_TIMEOUT_SECONDS } from "./config.js";
import { askAboutRepo } from "./agent.js";
import { getRepoCacheDir } from "./repoSync.js";
import { buildMemoryContext, extractAndUpdateMemory, getOrCreateSessionPath, deleteSession } from "./memory.js";
import { tryAcquireRateLimit, acquireWithQueuePosition, getQueuePosition } from "./utils/limits.js";
import { chunkAnswer } from "./utils/chunking.js";

const EMOJI_SEEN = "👀";
const EMOJI_DONE = "✅";
const EMOJI_ERROR = "❌";

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

const safe = (promise: Promise<unknown>) => promise.catch(() => void 0);

async function clearReactions(message: Message): Promise<void> {
  await Promise.all([...message.reactions.cache.values()]
    .map(r => safe(r.users.remove(client.user?.id))));
}

async function react(message: Message, emoji: string): Promise<void> {
  await safe(message.react(emoji));
}

const sanitizeThreadName = (text: string): string => {
  const cleaned = text
    .replace(/[^\w\s\-.,!?()[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.substring(0, 50) || "Codebase Question";
};

const isAllowedChannel = (id: string) =>
  ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(id);

function getThreadId(message: Message): string {
  if (message.channel.isThread()) {
    return message.channel.id;
  }
  return message.id;
}

async function handleQuestion(
  message: Message,
  botName: string,
  question: string,
  sessionPath: string,
  memoryContext: string
) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timeout")),
      ANSWER_TIMEOUT_SECONDS * 1000
    );
  });

  const resetTimer = () => timer?.refresh();

  try {
    const answer = await Promise.race([
      askAboutRepo(botName, question, getRepoCacheDir(), sessionPath, memoryContext, resetTimer),
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

    await react(message, EMOJI_DONE);
    return answer;
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.message === "timeout";
    console.error("[bot] handleQuestion error:", err);

    await message.reply(
      isTimeout
        ? `⏱️ That took too long (>${ANSWER_TIMEOUT_SECONDS}s). Try a more specific question.`
        : `❌ Something went wrong. Please try again.`
    );

    await react(message, EMOJI_ERROR);
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

  if (!tryAcquireRateLimit(message.author.id)) {
    await message.reply(
      `⚠️ You're doing that too often. Please wait a minute before asking another question.`
    );
    return;
  }

  await react(message, EMOJI_SEEN);

  const threadId = getThreadId(message);
  const sessionPath = getOrCreateSessionPath(threadId);
  console.log(`[bot] Using session ${sessionPath} for thread ${threadId}`);

  const memoryContext = await buildMemoryContext(message.author.id, message.author.username);

  const queuePos = getQueuePosition();
  await clearReactions(message);
  if (queuePos > 0) {
    await react(message, queuePos > 9 ? "🔟" : `${queuePos}⃣`);
  }

  const { release } = await acquireWithQueuePosition();

  await react(message, "⏳");

  let answer: string | null;
  try {
    answer = await handleQuestion(message, botName, question, sessionPath, memoryContext);
  } finally {
    release();
  }

  if (answer) {
    extractAndUpdateMemory(message.author.id, question, answer).catch(console.error);
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  c.user.setActivity("StarPilot questions", { type: ActivityType.Listening });
});

client.on(Events.Warn, (info) => {
  console.warn(`[bot] Warning: ${info}`);
});

client.on(Events.ShardDisconnect, (event, id) => {
  console.log(`[bot] Shard ${id} disconnected. Code: ${event.code}, reason: ${event.reason}`);
});

client.on(Events.ShardReconnecting, (id) => {
  console.log(`[bot] Reconnecting shard ${id}...`);
});

client.on(Events.ThreadDelete, (thread) => {
  deleteSession(thread.id);
});

export const isBotReady = () => client.isReady();
export const startBot = async () => client.login(config.DISCORD_TOKEN);
export const stopBot = async () => {
  await client.destroy();
};