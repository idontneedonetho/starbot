import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
  Events,
  ActivityType,
  REST,
} from "discord.js";
import { config, ALLOWED_CHANNEL_IDS, ANSWER_TIMEOUT_SECONDS, REPO_NAME } from "./config.js";
import { askAboutRepo } from "./agent.js";
import { getRepoCacheDir } from "./repoSync.js";
import { extractAndUpdateMemory, getOrCreateSessionPath, deleteSession } from "./memory.js";
import { tryAcquireRateLimit, acquireWithQueuePosition } from "./utils/limits.js";
import { chunkAnswer } from "./utils/chunking.js";
import { getAllCommands } from "./plugins/manager.js";
import { initPluginSystem, getCommand } from "./plugins/loader.js";
import { setupEventHandlers } from "./events/handler.js";

const EMOJI_SEEN = "👀";
const EMOJI_DONE = "✅";
const EMOJI_ERROR = "❌";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
let applicationId: string | null = null;

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

async function handleQuestion(
  message: Message,
  botName: string,
  question: string,
  userId: string
): Promise<{ answer: string; sessionThreadId: string } | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timeout")),
      ANSWER_TIMEOUT_SECONDS * 1000
    );
  });

  const resetTimer = () => timer?.refresh();

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

  const threadId = threadTarget ? threadTarget.id : message.channel.id;
  const threadSessionPath = getOrCreateSessionPath(threadId);

  try {
    const answer = await Promise.race([
      askAboutRepo(botName, question, getRepoCacheDir(), threadSessionPath, userId, resetTimer, resetTimer),
      timeout,
    ]);
    clearTimeout(timer);

    const chunks = chunkAnswer(answer);

    let lastMsg: Message = threadTarget
      ? await threadTarget.send(chunks[0])
      : await message.reply(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
      lastMsg = await lastMsg.reply(chunks[i]);
    }

    await clearReactions(message);
    await react(message, EMOJI_DONE);
    return { answer, sessionThreadId: threadId };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.message === "timeout";
    console.error("[bot] handleQuestion error:", err);

    if (threadTarget) {
      await threadTarget.send(
        isTimeout
          ? `⏱️ That took too long (>${ANSWER_TIMEOUT_SECONDS}s). Try a more specific question.`
          : `❌ Something went wrong. Please try again.`
      );
    } else {
      await message.reply(
        isTimeout
          ? `⏱️ That took too long (>${ANSWER_TIMEOUT_SECONDS}s). Try a more specific question.`
          : `❌ Something went wrong. Please try again.`
      );
    }

    await clearReactions(message);
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

  const content = message.content;
  const botName = message.guild?.members.me?.nickname || client.user.displayName || client.user.username || "StarBot";

  const question = stripMentions(content);

  if (!question) {
    await message.reply(
      `Hey! Ask me anything about the ${REPO_NAME} codebase.\n` +
      `Example: \`@${botName} what vehicles are supported?\`\n\n` +
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
  await clearReactions(message);

  const { release, position: queuePos } = await acquireWithQueuePosition();

  if (queuePos > 0) {
    await react(message, queuePos > 9 ? "🔟" : `${queuePos}⃣`);
  }

  await react(message, "⏳");

  const userId = message.author.id;

  let answer: string | null = null;
  try {
    const result = await handleQuestion(message, botName, question, userId);
    if (result) {
      answer = result.answer;
    }
  } finally {
    release();
  }

  if (answer) {
    extractAndUpdateMemory(message.author.id, question, answer).catch(console.error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;

  // Check plugin commands
  const pluginCommand = getAllCommands().find(c => c.data.name === commandName);
  if (pluginCommand) {
    try {
      await pluginCommand.execute(interaction);
    } catch (err) {
      console.error(`[bot] Plugin command ${commandName} error:`, err);
      await interaction.reply("❌ An error occurred.");
    }
    return;
  }

  // Check dynamically loaded commands
  const dynamicCommand = getCommand(commandName);
  if (dynamicCommand) {
    try {
      await dynamicCommand.execute(interaction);
    } catch (err) {
      console.error(`[bot] Command ${commandName} error:`, err);
      await interaction.reply("❌ An error occurred while executing this command.");
    }
    return;
  }

  console.warn(`[bot] Received interaction for unknown command: ${commandName}`);
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  c.user.setActivity(`${REPO_NAME} questions`, { type: ActivityType.Listening });

  applicationId = c.user.id;
  initPluginSystem(client, rest, applicationId);
  setupEventHandlers(client);

  // Register plugin manager commands
  const { getAllCommands: getPluginCmds } = await import("./plugins/manager.js");
  const pluginCommands = getPluginCmds().map(c => c.data.toJSON());
  
  try {
    await rest.put(
      `/applications/${applicationId}/commands`,
      { body: pluginCommands }
    );
    console.log("[bot] Registered plugin commands: /manage");
  } catch (err) {
    console.error("[bot] Failed to register plugin commands:", err);
  }
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