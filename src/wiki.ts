import fs from "fs";
import path from "path";
import { WIKI_DIR } from "./config.js";
import { runWikiUpdate } from "./agent.js";

const RAW_THREADS_DIR = path.join(WIKI_DIR, "raw", "threads");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function saveRawInteraction(threadId: string, userId: string, question: string, answer: string): void {
  ensureDir(RAW_THREADS_DIR);
  const filePath = path.join(RAW_THREADS_DIR, `${threadId}.md`);
  const timestamp = new Date().toISOString();
  const entry = `## [${timestamp}] user:${userId}\n${question}\n\n## [${timestamp}] bot\n${answer}\n\n`;
  fs.appendFileSync(filePath, entry, "utf-8");
}

export async function afterExchange(threadId: string, userId: string, question: string, answer: string): Promise<void> {
  try {
    await runWikiUpdate({ threadId, userId, question, answer });
  } catch (err) {
    console.warn(`[wiki] Update failed:`, err);
  }
}

export function ensureWikiStructure(): void {
  for (const sub of ["concepts", "entities", "users", "raw/threads"]) {
    ensureDir(path.join(WIKI_DIR, sub));
  }
}
