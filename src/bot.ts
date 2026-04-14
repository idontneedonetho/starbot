import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  Events,
  ActivityType,
} from "discord.js";
import { config } from "./config.js";
import { askAboutRepo, type ConversationTurn } from "./agent.js";
import { getRepoCacheDir } from "./repoSync.js";
import { buildMemoryContext, extractAndUpdateMemory } from "./memory.js";

const EMOJI_SEEN  = "👀";
const EMOJI_DONE  = "✅";
const EMOJI_ERROR = "❌";
const MAX_HISTORY_DEPTH = 4;
const MAX_CONCURRENT = 2;

// Simple promise-based semaphore to bound concurrent agent sessions
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.active++; resolve(); });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const agentSemaphore = new Semaphore(MAX_CONCURRENT);

// Initialize Discord client with necessary permissions
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

// Strips user mentions from message text
const stripMentions = (text: string) => text.replace(/<@!?\d+>/g, "").trim();

// Checks if bot is permitted to respond in the channel
const isAllowedChannel = (id: string) => 
  config.ALLOWED_CHANNEL_IDS.length === 0 || config.ALLOWED_CHANNEL_IDS.includes(id);

// Splits long messages while preserving codeblock contexts across discord's 2000 char threshold
function chunkAnswer(text: string, maxLen = 2000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > maxLen) {
    const chunkLimit = maxLen - 20; // buffer for appending closing ticks
    let split = remaining.lastIndexOf("\n", chunkLimit);
    if (split < chunkLimit / 2) split = chunkLimit;

    let inCodeBlock = false;
    let lang = "";
    
    const lines = remaining.slice(0, split).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        if (inCodeBlock) {
          inCodeBlock = false;
          lang = "";
        } else {
          inCodeBlock = true;
          lang = trimmed.slice(3).trim();
        }
      }
    }

    let chunkText = remaining.slice(0, split);
    let nextText = remaining.slice(split).trimStart();

    if (inCodeBlock) {
      chunkText += "\n```";
      nextText = "```" + lang + "\n" + nextText;
    }

    chunks.push(chunkText);
    remaining = nextText;
  }
  
  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

async function removeReaction(message: Message, emoji: string) {
  if (client.user) {
    await message.reactions.cache.get(emoji)?.users.remove(client.user.id).catch(() => void 0);
  }
}

// Reconstructs reply history for context by crawling up the message chain
async function buildConversationHistory(message: Message): Promise<ConversationTurn[]> {
  if (!client.user) return [];

  const turns: ConversationTurn[] = [];
  let ref: typeof message.reference | undefined = message.reference;

  while (ref?.messageId && turns.length < MAX_HISTORY_DEPTH) {
    const botMsg: Message | null = await message.channel.messages.fetch(ref.messageId).catch(() => null);
    if (botMsg?.author.id !== client.user.id) break;

    // Only read actual message content (ignore embeds entirely)
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

// Executes agent inference with timeout limits
async function handleQuestion(
  message: Message,
  botName: string,
  question: string,
  memoryContext: string,
  history: ConversationTurn[]
) {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timeout")),
      config.ANSWER_TIMEOUT_SECONDS * 1000
    );
  });

  const resetTimer = () => timer.refresh();

  try {
    const answer = await Promise.race([
      askAboutRepo(botName, question, getRepoCacheDir(), memoryContext, history, resetTimer),
      timeout,
    ]);
    clearTimeout(timer!);

    const chunks = chunkAnswer(answer);
    let lastMsg = await message.reply(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
      if (message.channel.isSendable()) {
        lastMsg = await lastMsg.reply(chunks[i]);
      }
    }

    await removeReaction(message, EMOJI_SEEN);
    await message.react(EMOJI_DONE).catch(() => void 0);
    return answer;
  } catch (err) {
    clearTimeout(timer!);
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

// Primary entry point for questions directed at the bot
client.on(Events.MessageCreate, async (message: Message) => {
  if (
    message.author.bot || 
    !client.user || 
    !message.mentions.has(client.user) || 
    !isAllowedChannel(message.channelId)
  ) return;

  const question = stripMentions(message.content);
  const botName = message.guild?.members.me?.nickname || client.user.displayName || client.user.username || "StarBot";

  // Return usage help if just blindly tagged
  if (!question) {
    await message.reply(
      `Hey! Ask me anything about the StarPilot codebase.\n` +
      `Example: \`@${botName} what GM vehicles are supported?\`\n\n` +
      `💡 Reply to one of my answers to continue the conversation in context.\n` +
      `🧠 I'll also pick up on things you mention about your setup and remember them.`
    );
    return;
  }

  await message.react(EMOJI_SEEN).catch(() => void 0);

  const history = await buildConversationHistory(message);
  if (history.length) {
    console.log(`[bot] Resuming thread with ${history.length} prior turn(s) for ${message.author.username}`);
  }

  const memoryContext = buildMemoryContext(message.author.id, message.author.username);

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
export const stopBot = async () => client.destroy();
