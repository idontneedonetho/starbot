import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { singleTurnLlm } from "./agent.js";
import { EXTRACTOR_SYSTEM, COMPRESSOR_SYSTEM } from "./prompts.js";
import { SESSION_DIR } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/memories.db");

const MAX_FACTS = 5;
const MIN_CONFIDENCE = 3;
const SESSION_MAX_AGE_DAYS = 30;

const VALID_CATEGORIES = new Set(["vehicle", "hardware", "expertise", "preference", "useCase", "knownIssues", "goals"]);

function isValidFact(f: unknown): f is { category: string; content: string; confidence: number } {
  if (!f || typeof f !== "object") return false;
  const obj = f as Record<string, unknown>;
  return (
    VALID_CATEGORIES.has(obj.category as string) &&
    typeof obj.content === "string" &&
    typeof obj.confidence === "number" &&
    obj.confidence >= MIN_CONFIDENCE
  );
}

function parseFactsFromLLM(raw: string): { category: string; content: string; confidence: number }[] {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed)) {
      return parsed.filter(isValidFact);
    }
    return [];
  } catch {
    return [];
  }
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        facts TEXT DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
  }
  return db;
}

type Fact = { category: string; content: string; confidence: number };

function getProfile(userId: string): { facts: Fact[] } {
  const row = getDb().prepare("SELECT facts FROM user_profiles WHERE user_id = ?").get(userId) as { facts: string } | undefined;
  if (!row) return { facts: [] };
  return {
    facts: JSON.parse(row.facts),
  };
}

function saveProfile(userId: string, facts: Fact[]): void {
  getDb().prepare(`
    INSERT INTO user_profiles (user_id, facts, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET facts = excluded.facts, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(facts), new Date().toISOString());
}

let sessionDirEnsured = false;

function ensureSessionDir(): void {
  if (!sessionDirEnsured) {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
    sessionDirEnsured = true;
  }
}

export function cleanupOldSessions(): void {
  ensureSessionDir();
  try {
    const now = Date.now();
    const entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
    let cleaned = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionPath = path.join(SESSION_DIR, entry.name);
      const stats = fs.statSync(sessionPath);
      const ageDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > SESSION_MAX_AGE_DAYS) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[memory] Cleaned up ${cleaned} stale session(s)`);
    }
  } catch (err) {
    console.warn("[memory] Session cleanup failed:", err);
  }
}

export function getOrCreateSessionPath(threadId: string): string {
  ensureSessionDir();
  return path.join(SESSION_DIR, threadId);
}

export function deleteSession(threadId: string): void {
  const sessionDir = path.join(SESSION_DIR, threadId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`[memory] Deleted session for thread ${threadId}`);
  }
}

function formatFactsForCompression(facts: Fact[]): string {
  return `Facts:\n${facts.map((f) => `[${f.category}] ${f.content}`).join("\n")}`;
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
    let finalFacts: Fact[];
    if (merged.length > MAX_FACTS) {
      const limited = merged.slice(-MAX_FACTS);
      const summary = await singleTurnLlm(COMPRESSOR_SYSTEM, formatFactsForCompression(limited));
      finalFacts = [{ category: "preference", content: summary.trim(), confidence: 5 }];
      console.log(`[memory] Compressed ${limited.length} facts for user ${userId}`);
    } else {
      finalFacts = merged;
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
    expertise: [],
    preference: [],
    useCase: [],
    knownIssues: [],
    goals: [],
  };

  for (const fact of profile.facts) {
    byCategory[fact.category].push(fact.content);
  }

  const parts: string[] = [`[What you know about ${username}]`];

  if (byCategory.vehicle.length) parts.push(`Vehicle: ${byCategory.vehicle.join(", ")}`);
  if (byCategory.hardware.length) parts.push(`Hardware: ${byCategory.hardware.join(", ")}`);
  if (byCategory.expertise.length) parts.push(`Expertise: ${byCategory.expertise.join(", ")}`);
  if (byCategory.preference.length) parts.push(`Preferences: ${byCategory.preference.join(", ")}`);
  if (byCategory.useCase.length) parts.push(`Use Case: ${byCategory.useCase.join(", ")}`);
  if (byCategory.knownIssues.length) parts.push(`Known Issues: ${byCategory.knownIssues.join(", ")}`);
  if (byCategory.goals.length) parts.push(`Goals: ${byCategory.goals.join(", ")}`);

  return parts.join("\n") + "\n\nUse this context if relevant to their question.\n\n";
}