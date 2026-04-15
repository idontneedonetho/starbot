import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { object, string, number, enums, validate } from "superstruct";
import { singleTurnLlm } from "./agent.js";
import { EXTRACTOR_SYSTEM, COMPRESSOR_SYSTEM } from "./prompts.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/memories.db");

const MAX_FACTS = 5;
const MIN_CONFIDENCE = 3;

const CategoryStruct = enums(["vehicle", "hardware", "role", "preference"]);
const FactStruct = object({
  category: CategoryStruct,
  content: string(),
  confidence: number(),
});

interface Fact {
  category: "vehicle" | "hardware" | "role" | "preference";
  content: string;
  confidence: number;
}

function parseFactsFromLLM(raw: string): Fact[] {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((f): f is Fact => {
          const [error] = validate(f, FactStruct);
          if (error) return false;
          return (f as Fact).confidence >= MIN_CONFIDENCE;
        });
    }
    return [];
  } catch {
    return [];
  }
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    facts TEXT DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
`);

function getProfile(userId: string): { facts: Fact[] } {
  const row = db.prepare("SELECT facts FROM user_profiles WHERE user_id = ?").get(userId) as { facts: string } | undefined;
  if (!row) return { facts: [] };
  return {
    facts: JSON.parse(row.facts),
  };
}

function saveProfile(userId: string, facts: Fact[]): void {
  db.prepare(`
    INSERT INTO user_profiles (user_id, facts, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET facts = excluded.facts, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(facts), new Date().toISOString());
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
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log(`[memory] Deleted session for thread ${threadId}`);
  }
}

function formatFactsForCompression(facts: Fact[]): string {
  return `Facts:\n${facts.map((f, i) => `[${f.category}] ${f.content}`).join("\n")}`;
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

    const newFacts = parseFactsFromLLM(raw);
    if (newFacts.length === 0) return;

    const existingContents = new Set(profile.facts.map(f => f.content.toLowerCase()));
    const uniqueNewFacts = newFacts.filter(f => !existingContents.has(f.content.toLowerCase()));

    if (uniqueNewFacts.length === 0) return;

    const merged = [...profile.facts, ...uniqueNewFacts];
    const limited = merged.slice(-MAX_FACTS);

    let finalFacts: Fact[];
    if (limited.length > MAX_FACTS) {
      const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, formatFactsForCompression(limited));
      finalFacts = [{ category: "preference", content: summary.trim(), confidence: 5 }];
      console.log(`[memory] Compressed ${limited.length} facts for user ${userId}`);
    } else {
      finalFacts = limited;
    }

    saveProfile(userId, finalFacts);
    console.log(`[memory] Updated ${uniqueNewFacts.length} fact(s) for user ${userId}`);
  } catch (err) {
    console.warn("[memory] extractAndUpdateMemory failed:", err);
  }
}

export async function buildMemoryContext(userId: string, username: string): Promise<string> {
  const profile = getProfile(userId);
  if (profile.facts.length === 0) return "";

  const byCategory: Record<string, string[]> = {
    vehicle: [],
    hardware: [],
    role: [],
    preference: [],
  };

  for (const fact of profile.facts) {
    byCategory[fact.category].push(fact.content);
  }

  const parts: string[] = [`[What you know about ${username}]`];
  
  if (byCategory.vehicle.length) {
    parts.push(`Vehicle: ${byCategory.vehicle.join(", ")}`);
  }
  if (byCategory.hardware.length) {
    parts.push(`Hardware: ${byCategory.hardware.join(", ")}`);
  }
  if (byCategory.role.length) {
    parts.push(`Role: ${byCategory.role.join(", ")}`);
  }
  if (byCategory.preference.length) {
    parts.push(`Preferences: ${byCategory.preference.join(", ")}`);
  }

  return parts.join("\n") + "\n\nUse this context if relevant to their question.\n\n";
}