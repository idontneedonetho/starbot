import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { singleTurnLlm } from "./agent.js";
import { EXTRACTOR_SYSTEM, COMPRESSOR_SYSTEM } from "./prompts.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/memories.db");

const MAX_FACTS = 10;

function parseJsonArrayFromLLM<T>(raw: string): T[] {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((f): f is T => typeof f === "string");
    }
    return [];
  } catch {
    return [];
  }
}

function buildCompressPrompt(facts: string[]): string {
  return `Facts:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    facts TEXT DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
`);

function getProfile(userId: string): { facts: string[] } {
  const row = db.prepare("SELECT facts FROM user_profiles WHERE user_id = ?").get(userId) as { facts: string } | undefined;
  if (!row) return { facts: [] };
  return {
    facts: JSON.parse(row.facts),
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

function ensureSessionDir(): void {
  if (!fs.existsSync(config.SESSION_DIR)) {
    fs.mkdirSync(config.SESSION_DIR, { recursive: true });
  }
}

export function getOrCreateSessionPath(threadId: string): string {
  ensureSessionDir();
  return path.join(config.SESSION_DIR, `${threadId}.jsonl`);
}

export function deleteSession(threadId: string): void {
  const sessionPath = path.join(config.SESSION_DIR, `${threadId}.jsonl`);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
    console.log(`[memory] Deleted session for thread ${threadId}`);
  }
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

  if (profile.facts.length === 0) return "";

  const factsText = profile.facts.length === 1
    ? profile.facts[0]
    : profile.facts.map((f) => `- ${f}`).join("\n");

  return `[What you know about ${username}]\n${factsText}\n\nUse this context if relevant to their question.\n\n`;
}