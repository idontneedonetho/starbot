import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { singleTurnLlm } from "./agent.js";
import { EXTRACTOR_SYSTEM, COMPRESSOR_SYSTEM, REFRESH_SYSTEM } from "./prompts/memory.js";
import { parseJsonArrayFromLLM, buildCompressPrompt } from "./utils/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/memories.db");

const MAX_FACTS = 10;
const MAX_CONVERSATION_PAIRS = 10;
const MEMORY_REFRESH_BATCH_SIZE = 5;

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

    const newFacts: string[] = parseJsonArrayFromLLM(raw);

    saveConversation(userId, question, answer);

    if (newFacts.length === 0) return;

    const merged = [...profile.facts, ...newFacts];

    let finalFacts: string[];
    if (merged.length > MAX_FACTS) {
      const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, buildCompressPrompt(merged));
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

export async function refreshAllUserMemories(): Promise<void> {
  console.log("[memory] Starting periodic memory refresh...");

  const userIds = db.prepare("SELECT user_id FROM user_profiles").all() as { user_id: string }[];
  let refreshed = 0;

  const processUser = async (userId: string): Promise<boolean> => {
    try {
      const history = getConversationHistory(userId);
      if (history.length === 0) return false;

      const historyText = history
        .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
        .join("\n\n---\n\n");

      const raw = await singleTurnLlm(REFRESH_SYSTEM, historyText);

      const newFacts: string[] = parseJsonArrayFromLLM(raw);
      if (newFacts.length === 0) return false;

      let finalFacts: string[];
      if (newFacts.length > MAX_FACTS) {
        const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, buildCompressPrompt(newFacts));
        finalFacts = [summary.trim()];
      } else {
        finalFacts = newFacts;
      }

      saveProfile(userId, finalFacts);
      return true;
    } catch (err) {
      console.warn(`[memory] Failed to refresh memory for user ${userId}:`, err);
      return false;
    }
  };

  for (let i = 0; i < userIds.length; i += MEMORY_REFRESH_BATCH_SIZE) {
    const batch = userIds.slice(i, i + MEMORY_REFRESH_BATCH_SIZE);
    const results = await Promise.all(batch.map((u) => processUser(u.user_id)));
    refreshed += results.filter(Boolean).length;
  }

  console.log(`[memory] Refreshed ${refreshed}/${userIds.length} user profiles`);
}
