import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { singleTurnLlm } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/memories.db");

const MAX_FACTS = 10;
const MAX_CONVERSATION_PAIRS = 10;

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    facts TEXT DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
`);

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

function getProfile(userId: string): { facts: string[]; updatedAt: string } {
  const row = db.prepare("SELECT facts, updated_at FROM user_profiles WHERE user_id = ?").get(userId) as { facts: string; updated_at: string } | undefined;
  if (!row) return { facts: [], updatedAt: new Date().toISOString() };
  return {
    facts: JSON.parse(row.facts),
    updatedAt: row.updated_at,
  };
}

function saveProfile(userId: string, facts: string[]): void {
  const stmt = db.prepare(`
    INSERT INTO user_profiles (user_id, facts, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET facts = excluded.facts, updated_at = excluded.updated_at
  `);
  stmt.run(userId, JSON.stringify(facts), new Date().toISOString());
}

function saveConversation(userId: string, question: string, answer: string): void {
  db.prepare(`
    INSERT INTO conversations (user_id, question, answer, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, question, answer, new Date().toISOString());

  db.prepare(`
    DELETE FROM conversations WHERE user_id = ? AND id NOT IN (
      SELECT id FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    )
  `).run(userId, userId, MAX_CONVERSATION_PAIRS);
}

function getConversationHistory(userId: string): { question: string; answer: string }[] {
  const rows = db.prepare(`
    SELECT question, answer FROM conversations 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(userId, MAX_CONVERSATION_PAIRS) as { question: string; answer: string }[];
  return rows.reverse();
}

export async function extractAndUpdateMemory(
  userId: string,
  question: string,
  answer: string
): Promise<void> {
  try {
    const profile = getProfile(userId);

    const prompt = `Question from user: ${question}\n\nBot's answer: ${answer}`;
    const raw = await singleTurnLlm(EXTRACTOR_SYSTEM, prompt);

    let newFacts: string[] = [];
    try {
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) newFacts = parsed.filter((f) => typeof f === "string");
    } catch {
      // Failed to parse, skip
    }

    saveConversation(userId, question, answer);

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

    saveProfile(userId, finalFacts);
    console.log(`[memory] Updated ${newFacts.length} fact(s) for user ${userId}`);
  } catch (err) {
    console.warn("[memory] extractAndUpdateMemory failed:", err);
  }
}

export async function buildMemoryContext(userId: string, username: string): Promise<string> {
  const profile = getProfile(userId);
  const conversationHistory = getConversationHistory(userId);

  const parts: string[] = [];

  if (profile.facts.length) {
    const factsText = profile.facts.length === 1
      ? profile.facts[0]
      : profile.facts.map((f) => `- ${f}`).join("\n");
    parts.push(`[What you know about ${username}]\n${factsText}`);
  }

  if (conversationHistory.length) {
    const historyText = conversationHistory
      .slice(-3)
      .map((c) => `Q: ${c.question}\nA: ${c.answer.slice(0, 200)}`)
      .join("\n\n");
    parts.push(`[Recent conversation]\n${historyText}`);
  }

  if (!parts.length) return "";

  return parts.join("\n\n") + "\n\nUse this context if relevant to their question.\n\n";
}

const REFRESH_SYSTEM = `\
You are a fact extractor for a Q&A Discord bot about StarPilot.
Given a user's FULL conversation history, extract ALL facts about the USER.
Include any facts from past questions and answers.

Focus ONLY on facts about the user:
- Their vehicle (year/make/model)
- Their comma device (C3, C3X, C4)
- Hardware modifications
- Their role or goals
- Any preferences

Return a JSON array of short fact strings. Consolidate similar facts.
Return ONLY the JSON array, no other text.`;

export async function refreshAllUserMemories(): Promise<void> {
  console.log("[memory] Starting periodic memory refresh...");

  const userIds = db.prepare("SELECT user_id FROM user_profiles").all() as { user_id: string }[];
  let refreshed = 0;

  for (const { user_id: userId } of userIds) {
    try {
      const history = getConversationHistory(userId);
      if (history.length === 0) continue;

      const profile = getProfile(userId);
      const historyText = history
        .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
        .join("\n\n---\n\n");

      const raw = await singleTurnLlm(REFRESH_SYSTEM, historyText);

      let newFacts: string[] = [];
      try {
        const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) newFacts = parsed.filter((f) => typeof f === "string");
      } catch {
        continue;
      }

      if (newFacts.length === 0) continue;

      let finalFacts: string[];
      if (newFacts.length > MAX_FACTS) {
        const compressPrompt = `Facts:\n${newFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
        const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, compressPrompt);
        finalFacts = [summary.trim()];
      } else {
        finalFacts = newFacts;
      }

      saveProfile(userId, finalFacts);
      refreshed++;
    } catch (err) {
      console.warn(`[memory] Failed to refresh memory for user ${userId}:`, err);
    }
  }

  console.log(`[memory] Refreshed ${refreshed}/${userIds.length} user profiles`);
}
