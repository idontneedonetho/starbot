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

const DEFAULT_WIKI_SCHEMA = `\
# Wiki Schema

You maintain a markdown wiki about users of a Discord Q&A bot for the StarPilot project.
The wiki is compiled knowledge that sits between raw Q&A exchanges and the agent's context.
You write it; the agent reads it.

## Page Structure

Each user has one wiki file: \`{userId}.md\` with YAML frontmatter + markdown body.

### Frontmatter
\`\`\`yaml
---
title: "User {userId}"
type: user-profile
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

Keep created/updated dates accurate. The "type" field is always \`user-profile\`.

### Sections (## headers)
Use any of these as warranted, create new ones as needed:
- **Profile** — general details, skill level, project role
- **Vehicle** — make, model, year, trim, supported features
- **Hardware** — comma device, car harness, accessories, installed software
- **Features** — what they use (OpenPilot, lane keeping, etc.)
- **Issues** — problems encountered and resolutions
- **Preferences** — driving style, tuning preferences, communication style
- **Setup** — installation details, firmware versions, custom configs
- **Conversations** — brief log of past questions and answers (optional)

## Update Rules

Given existing wiki content and a new Q&A exchange:

1. Integrate any new information about the user into the wiki.
2. Update existing sections, add new sections, remove stale information.
3. If the Q&A contains facts about the user that could affect answers (vehicle, setup, issues, preferences), those go in the wiki.
4. If the exchange reveals no new user information, return the wiki unchanged.
5. Remove outdated or contradicted information when updating.
6. Be concise but specific — prefer "2025 Chevy Bolt EV with comma three" over "EV with comma device".
7. Output ONLY the complete updated wiki file content (frontmatter + body). No commentary.

## Index and Log

- **INDEX.md** catalogs all user wikis with one-line summaries.
- **LOG.md** is append-only. Add an entry on each update: \`## [date] update | userId | brief description of what changed\`

## Raw Sources

Each Q&A exchange is stored as an immutable file in \`raw/{userId}/{timestamp}-qa.md\`.
These are never modified. The wiki is compiled from them, not the other way around.
If a claim in the wiki seems wrong, check the raw exchange it came from.`;

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
  const runtime = readFile(SCHEMA_PATH);
  if (runtime.trim()) return runtime;
  return DEFAULT_WIKI_SCHEMA;
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
      ? `Existing wiki:\n${existing}\n\nNew Q&A:\nQ: ${question}\nA: ${answer}`
      : `No existing wiki yet. Create one from this Q&A:\nQ: ${question}\nA: ${answer}`;

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


