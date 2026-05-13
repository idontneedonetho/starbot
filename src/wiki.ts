import fs from "fs";
import path from "path";
import { WIKI_DIR } from "./config.js";
import { runWikiUpdate } from "./agent.js";

export const WIKI_UPDATE_SYSTEM = `A Q&A exchange just happened. You maintain the wiki.

Read SCHEMA.md first to understand the wiki structure and conventions.
Read index.md to see what pages already exist.
Read any existing pages that are relevant to the exchange.
Read the raw conversation at raw/threads/{threadId}.md for full context.

Your job is to update the wiki to reflect the new knowledge:
- Create or update concept pages in concepts/ for codebase ideas and mechanisms
- Create or update entity pages in entities/ for car models, hardware, devices, people
- Create or update user pages in users/ for the people involved
- Cross-reference pages using [[wiki-link]] notation
- Every page needs YAML frontmatter (title, type, created, updated, tags, sources)
- If new info contradicts existing pages, add a Conflicts section — don't silently overwrite
- Update index.md with any new or significantly changed pages
- Append an entry to log.md describing what changed

Use your tools (read, write, edit, grep, find, ls) to make all changes directly.
Do not output file contents — use write/edit tools to apply them.`;

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
