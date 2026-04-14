import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { singleTurnLlm } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORIES_PATH = path.resolve(__dirname, "../data/memories.json");

const MAX_FACTS = 10;

class AsyncMutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.locked = true; resolve(); });
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const memoryMutex = new AsyncMutex();

type UserProfile = {
  facts: string[];
  updatedAt: string;
};

type MemoryStore = Record<string, UserProfile>;

async function load(): Promise<MemoryStore> {
  try {
    if (!fsSync.existsSync(MEMORIES_PATH)) return {};
    return JSON.parse(await fs.readFile(MEMORIES_PATH, "utf-8")) as MemoryStore;
  } catch {
    return {};
  }
}

async function save(store: MemoryStore): Promise<void> {
  await fs.mkdir(path.dirname(MEMORIES_PATH), { recursive: true });
  await fs.writeFile(MEMORIES_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function getProfile(userId: string): UserProfile {
  return { facts: [], updatedAt: new Date().toISOString() };
}

async function getProfileAsync(userId: string): Promise<UserProfile> {
  const store = await load();
  return store[userId] ?? { facts: [], updatedAt: new Date().toISOString() };
}

async function saveProfile(userId: string, profile: UserProfile): Promise<void> {
  const store = await load();
  store[userId] = { ...profile, updatedAt: new Date().toISOString() };
  await save(store);
}

const EXTRACTOR_SYSTEM = `\
You are a fact extractor for a Q&A Discord bot about StarPilot (an openpilot fork for GM vehicles).
Given a user's question and the bot's answer, extract any facts about the USER that would be useful to remember.

Focus ONLY on facts about the user, such as:
- Their vehicle (year/make/model, e.g. "Has a 2019 Chevy Bolt EV")
- Their comma device (C3, C3X, C4)
- Hardware modifications (pedal interceptor, ZSS, etc.)
- Their role or goals (developer, daily driver, tester, etc.)
- Any explicit preferences or constraints they mentioned

Return a JSON array of short fact strings. If there is nothing to extract, return an empty array [].
Do NOT include facts about StarPilot itself — only facts about the user.
Return ONLY the JSON array, no other text.`;

const COMPRESSOR_SYSTEM = `\
You are a memory compressor for a Discord bot. Given a list of facts about a user, consolidate them into a concise, accurate paragraph.
- Remove duplicates
- Prefer newer/more specific information over older/vaguer info
- Keep it under 80 words
- Write in third person ("The user has...", "They use...")
Return ONLY the paragraph, no other text.`;

/** Extracts user facts from a Q&A and updates their persistent profile */
export async function extractAndUpdateMemory(
  userId: string,
  question: string,
  answer: string
): Promise<void> {
  await memoryMutex.acquire();
  try {
    const profile = await getProfileAsync(userId);

    const prompt = `Question from user: ${question}\n\nBot's answer: ${answer}`;
    const raw = await singleTurnLlm(EXTRACTOR_SYSTEM, prompt);

    let newFacts: string[] = [];
    try {
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) newFacts = parsed.filter((f) => typeof f === "string");
    } catch {
      return;
    }

    if (newFacts.length === 0) return;

    const merged = [...profile.facts, ...newFacts];

    let finalFacts: string[];
    if (merged.length > MAX_FACTS) {
      const compressPrompt = `Facts:\n${merged.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
      const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, compressPrompt);
      finalFacts = [summary.trim()];
      console.log(`[memory] Compressed ${merged.length} facts for user ${userId}`);
    } else {
      finalFacts = merged;
    }

    await saveProfile(userId, { ...profile, facts: finalFacts });
    console.log(`[memory] Updated ${newFacts.length} fact(s) for user ${userId}`);
  } catch (err) {
    console.warn("[memory] extractAndUpdateMemory failed:", err);
  } finally {
    memoryMutex.release();
  }
}

/** Formats user profile facts for injection into agent context */
export async function buildMemoryContext(userId: string, username: string): Promise<string> {
  const profile = await getProfileAsync(userId);
  if (!profile.facts.length) return "";

  const factsText = profile.facts.length === 1
    ? profile.facts[0]
    : profile.facts.map((f) => `- ${f}`).join("\n");

  return (
    `[What you know about ${username}]\n${factsText}\n\n` +
    `Use this context if it is relevant to their question.\n\n`
  );
}
