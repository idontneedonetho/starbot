import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { singleTurnLlm } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORIES_PATH = path.resolve(__dirname, "../data/memories.json");

// Max facts before we auto-compress to a summary paragraph
const MAX_FACTS = 10;

// Async mutex to prevent concurrent read-modify-write races on memories.json
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
  facts: string[];      // Extracted atomic facts about the user
  updatedAt: string;
};

type MemoryStore = Record<string, UserProfile>; // keyed by Discord user ID

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function load(): MemoryStore {
  try {
    if (!fs.existsSync(MEMORIES_PATH)) return {};
    return JSON.parse(fs.readFileSync(MEMORIES_PATH, "utf-8")) as MemoryStore;
  } catch {
    return {};
  }
}

function save(store: MemoryStore): void {
  fs.mkdirSync(path.dirname(MEMORIES_PATH), { recursive: true });
  fs.writeFileSync(MEMORIES_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function getProfile(userId: string): UserProfile {
  return load()[userId] ?? { facts: [], updatedAt: new Date().toISOString() };
}

function saveProfile(userId: string, profile: UserProfile): void {
  const store = load();
  store[userId] = { ...profile, updatedAt: new Date().toISOString() };
  save(store);
}

// ---------------------------------------------------------------------------
// LLM-assisted extraction
// ---------------------------------------------------------------------------

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

/**
 * Extracts new facts from a Q&A exchange using a background LLM call.
 * Automatically merges them into the user's profile and compresses if needed.
 * Safe to fire-and-forget — errors are swallowed with a console warning.
 */
export async function extractAndUpdateMemory(
  userId: string,
  question: string,
  answer: string
): Promise<void> {
  await memoryMutex.acquire();
  try {
    const profile = getProfile(userId);

    // Step 1: Extract new facts from this Q&A
    const prompt = `Question from user: ${question}\n\nBot's answer: ${answer}`;
    const raw = await singleTurnLlm(EXTRACTOR_SYSTEM, prompt);

    let newFacts: string[] = [];
    try {
      // Strip markdown code fences if the model wraps it
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) newFacts = parsed.filter((f) => typeof f === "string");
    } catch {
      // Model didn't return valid JSON — skip this extraction
      return;
    }

    if (newFacts.length === 0) return; // nothing to remember

    // Step 2: Merge into profile
    const merged = [...profile.facts, ...newFacts];

    // Step 3: Auto-compress if we're getting long
    let finalFacts: string[];
    if (merged.length > MAX_FACTS) {
      const compressPrompt = `Facts:\n${merged.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
      const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, compressPrompt);
      // Store as a single "summary fact"
      finalFacts = [summary.trim()];
      console.log(`[memory] Compressed ${merged.length} facts for user ${userId}`);
    } else {
      finalFacts = merged;
    }

    saveProfile(userId, { ...profile, facts: finalFacts });
    console.log(`[memory] Updated ${newFacts.length} fact(s) for user ${userId}`);
  } catch (err) {
    console.warn("[memory] extractAndUpdateMemory failed:", err);
  } finally {
    memoryMutex.release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a formatted context string to inject into agent prompts.
 * Returns "" if the user has no stored facts.
 */
export function buildMemoryContext(userId: string, username: string): string {
  const profile = getProfile(userId);
  if (!profile.facts.length) return "";

  const factsText = profile.facts.length === 1
    ? profile.facts[0]                                    // compressed summary
    : profile.facts.map((f) => `- ${f}`).join("\n");     // bullet list

  return (
    `[What you know about ${username}]\n${factsText}\n\n` +
    `Use this context if it is relevant to their question.\n\n`
  );
}
