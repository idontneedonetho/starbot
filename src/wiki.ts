import fs from "fs";
import path from "path";
import { WIKI_DIR } from "./config.js";
import { runWikiUpdate } from "./agent.js";

const RAW_THREADS_DIR = path.join(WIKI_DIR, "raw", "threads");
const DEBOUNCE_DELAY = 30_000;
const pendingUpdates = new Map<string, NodeJS.Timeout>();

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

export function cancelPendingWikiUpdate(threadId: string): void {
  const timer = pendingUpdates.get(threadId);
  if (timer) {
    clearTimeout(timer);
    pendingUpdates.delete(threadId);
  }
}

export function afterExchange(threadId: string): void {
  cancelPendingWikiUpdate(threadId);
  const timer = setTimeout(async () => {
    pendingUpdates.delete(threadId);
    try {
      await runWikiUpdate({ threadId });
    } catch (err) {
      console.warn(`[wiki] Update failed:`, err);
    }
  }, DEBOUNCE_DELAY);
  pendingUpdates.set(threadId, timer);
}

export function ensureWikiStructure(): void {
  for (const sub of ["concepts", "entities", "users", "raw/threads"]) {
    ensureDir(path.join(WIKI_DIR, sub));
  }
}
