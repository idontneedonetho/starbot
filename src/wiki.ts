import fs from "fs";
import path from "path";
import { singleTurnLlm } from "./llm.js";
import { config } from "./config.js";

const WIKI_DIR = config.WIKI_DIR;
const SCHEMA_PATH = path.join(WIKI_DIR, ".SCHEMA.md");
const INDEX_PATH = path.join(WIKI_DIR, "INDEX.md");
const LOG_PATH = path.join(WIKI_DIR, "LOG.md");
const RAW_DIR = path.join(WIKI_DIR, "raw");

const UPDATE_INTERVAL_MS = 30_000;
const lastUpdate = new Map<string, number>();

function ensureDir(): void {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
}

function getWikiPath(userId: string): string {
  ensureDir();
  return path.join(WIKI_DIR, `${userId}.md`);
}

function readFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function readSchema(): string {
  return readFile(SCHEMA_PATH);
}

function appendLog(userId: string, summary: string): void {
  ensureDir();
  const date = new Date().toISOString().slice(0, 10);
  const line = `## [${date}] update | ${userId} | ${summary}\n`;
  fs.appendFileSync(LOG_PATH, line, "utf-8");
}

function updateIndex(userId: string, summary: string): void {
  ensureDir();
  const content = readFile(INDEX_PATH);
  const date = new Date().toISOString().slice(0, 10);

  const tableHeader = "| User | Summary | Created | Updated |";
  const tableSep = "|------|---------|---------|---------|";

  if (!content.trim()) {
    const lines = [
      "# Wiki Index",
      "",
      tableHeader,
      tableSep,
      `| ${userId} | ${summary} | ${date} | ${date} |`,
      "",
    ];
    fs.writeFileSync(INDEX_PATH, lines.join("\n"), "utf-8");
    return;
  }

  const lines = content.split("\n");
  const bodyLines = lines.slice(4).filter(l => l.trim());
  const existingIdx = bodyLines.findIndex(l => l.startsWith(`| ${userId} |`));

  const entry = `| ${userId} | ${summary} | ${date} | ${date} |`;

  if (existingIdx >= 0) {
    bodyLines[existingIdx] = entry;
  } else {
    bodyLines.push(entry);
  }

  const header = "# Wiki Index";
  const result = [header, "", tableHeader, tableSep, ...bodyLines, ""];
  fs.writeFileSync(INDEX_PATH, result.join("\n"), "utf-8");
}

function extractSummary(content: string, question: string): string {
  const firstLine = content.split("\n")[0]?.replace(/^#\s*/, "").trim();
  if (firstLine && firstLine.length > 3 && firstLine.length < 80) return firstLine;
  const words = question.split(/\s+/).slice(0, 10).join(" ");
  return words.length > 60 ? words.slice(0, 60) + "..." : words;
}

export function readUserWiki(userId: string): string {
  return readFile(getWikiPath(userId));
}

export function saveRawExchange(userId: string, question: string, answer: string): void {
  const dir = path.join(RAW_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const frontmatter = [
    "---",
    `user_id: "${userId}"`,
    `timestamp: ${new Date().toISOString()}`,
    "type: qa-exchange",
    "---",
  ].join("\n");
  const content = `${frontmatter}\n\nQ: ${question}\n\nA: ${answer}\n`;
  fs.writeFileSync(path.join(dir, `${timestamp}-qa.md`), content, "utf-8");
}

export async function updateUserWiki(
  userId: string,
  question: string,
  answer: string,
): Promise<void> {
  const now = Date.now();
  const last = lastUpdate.get(userId) ?? 0;
  if (now - last < UPDATE_INTERVAL_MS) return;
  lastUpdate.set(userId, now);

  try {
    const existing = readUserWiki(userId);
    const schema = readSchema();
    const prompt = existing
      ? `User ID: ${userId}\nExisting wiki:\n${existing}\n\nNew Q&A:\nQ: ${question}\nA: ${answer}`
      : `User ID: ${userId}\nNo existing wiki yet. Create one from this Q&A:\nQ: ${question}\nA: ${answer}`;

    const updated = await singleTurnLlm(schema, prompt);
    if (!updated) return;

    const trimmed = updated.trim();
    if (trimmed !== existing.trim()) {
      const wikiPath = getWikiPath(userId);
      const tmp = wikiPath + ".tmp";
      fs.writeFileSync(tmp, trimmed + "\n", "utf-8");
      fs.renameSync(tmp, wikiPath);
      const summary = extractSummary(trimmed, question);
      appendLog(userId, summary);
      updateIndex(userId, summary);
    }
  } catch (err) {
    console.warn(`[wiki] Update failed for user ${userId}:`, err);
  }
}


