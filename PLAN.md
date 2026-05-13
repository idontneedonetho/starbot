# Plan: LLM-Wiki for StarBot

## Architecture

The LLM fully owns the wiki. It reads, creates, updates, cross-references, and maintains everything using its built-in tools. TypeScript provides the directory scaffold, session isolation, and trigger wiring — nothing more.

---

## Directory Structure

```
data/wikis/
  SCHEMA.md          # Governance — tells the LLM the rules (no dot prefix)
  index.md           # Content catalog — LLM maintains this
  log.md             # Append-only operation log
  concepts/          # Codebase concepts (fingerprinting, CAN bus, safety model)
  entities/          # Physical things (car models, comma devices, panda)
  users/             # User profiles (moved from flat dir → users/{userId}.md)
  raw/
    threads/
      {threadId}.md  # One file per Discord thread, append-only, chronological
```

---

## Schema File (`SCHEMA.md`)

Renamed from `.SCHEMA.md`, rewritten per Karpathy pattern. Contents:

- Three-layer architecture explained (raw → wiki → schema)
- Directory layout and naming conventions (TitleCase for concepts/entities)
- YAML frontmatter template: `title`, `type` (concept|entity|user), `created`, `updated`, `tags`, `sources`
- Cross-reference rule: every page must use `[[wiki-link]]` to connect to related pages
- Contradiction handling: flag conflicts in a `## Conflicts` section, don't silently overwrite
- `index.md` maintenance: add/update entry for every new or changed page
- `log.md` maintenance: append on every operation with format `## [date] <action> | <summary>`
- The LLM co-evolves this schema over time

---

## Two Sessions

### Q&A Session (trigger: `@bot` mention)

| Property | Value |
|----------|-------|
| CWD | `REPO_CACHE_DIR` (starpilot codebase) |
| Tools | `read`, `grep`, `find`, `ls` |
| Write access | None — can't touch code or wiki |
| Prompt | Expert for repo + wiki exists at `WIKI_DIR`, read `SCHEMA.md` + `index.md` for context |

The agent reads code, reads wiki pages it finds relevant, answers. No memory injection, no programmatic context stuffing — it navigates the wiki itself.

### Wiki Update Session (trigger: after each answered question)

| Property | Value |
|----------|-------|
| CWD | `WIKI_DIR` |
| Tools | `read`, `write`, `edit`, `grep`, `find`, `ls` |
| Write access | Scoped to `WIKI_DIR` — codebase unreachable |
| Prompt | "A Q&A happened. Here's the exchange. Read the wiki, update/create pages, maintain index + log." |

The LLM reads the raw conversation from `raw/threads/{threadId}.md`, reads existing wiki pages, and decides what to create/update. Uses `write`/`edit` tools directly. TypeScript just awaits completion.

---

## Raw File Format (one `.md` per thread)

```markdown
## [2026-05-12T10:00:00Z] user:12345
What vehicles does StarPilot support?

## [2026-05-12T10:01:00Z] bot
StarPilot supports GM vehicles including...

## [2026-05-12T10:05:00Z] user:12345
Does the 2016 Chevy Volt work?
```

Append-only, chronological, one `read` call to get the full thread. Saved synchronously during Q&A before the async wiki update session fires.

---

## Code Changes

### `src/wiki.ts` — Rewrite

Remove user-specific functions (`readUserWiki`, `updateUserWiki`, `saveRawExchange`). Add:

- **`saveRawInteraction(threadId, userId, question, answer)`** — synchronous append to `raw/threads/{threadId}.md` with timestamped entry. Fire-and-forget from bot.ts.

- **`afterExchange(threadId, userId, question, answer)`** — async. Calls `runWikiUpdate` in agent.ts with the exchange data.

- **`migrate()`** — one-time startup migration:
  - Rename `.SCHEMA.md` → `SCHEMA.md`
  - Move `data/wikis/{userId}.md` → `data/wikis/users/{userId}.md`
  - Create `concepts/`, `entities/` dirs if missing
  - Convert any existing `raw/users/{userId}/*.md` to `raw/threads/{threadId}.md` format

### `src/agent.ts` — Changes

- **Remove** `memoryExtension` — LLM reads wiki itself
- **Remove** `readUserWiki` import from wiki.ts
- **Add** `runWikiUpdate(exchange)` — thin wrapper

### `src/bot.ts` — Changes

In the `MessageCreate` handler, after successful Q&A, swap out:
```ts
saveRawExchange(...)
updateUserWiki(...)
```
For:
```ts
saveRawInteraction(threadId, message.author.id, question, result.answer)
afterExchange(threadId, message.author.id, question, result.answer).catch(console.error)
```

Also have `handleQuestion` return the thread ID used.

### `src/prompts.ts` — Changes

- **Update `buildSystemPrompt`**: Add wiki paragraph — read `SCHEMA.md` and `index.md` for context, use `[[wiki-link]]`, knowledge compounds
- **Add `WIKI_UPDATE_SYSTEM`**: System prompt for post-Q&A wiki maintenance

### `src/index.ts` — Changes

Call `wiki.migrate()` after `validateConfig()` and before repo init.

---

## Migration (in `migrate()`)

| From | To |
|------|-----|
| `data/wikis/.SCHEMA.md` | `data/wikis/SCHEMA.md` (rewrite content) |
| `data/wikis/{userId}.md` | `data/wikis/users/{userId}.md` |
| (none) | `data/wikis/concepts/` |
| (none) | `data/wikis/entities/` |
| `data/wikis/raw/users/{userId}/*.md` | Accumulate into `data/wikis/raw/threads/{threadId}.md` |

---

## Files Summary

| File | Action |
|------|--------|
| `data/wikis/SCHEMA.md` | Rename from `.SCHEMA.md` + rewrite |
| `src/wiki.ts` | Rewrite |
| `src/agent.ts` | Remove `memoryExtension`, add `runWikiUpdate` |
| `src/prompts.ts` | Update `buildSystemPrompt`, add `WIKI_UPDATE_SYSTEM` |
| `src/bot.ts` | Swap out user-specific calls for `afterExchange` |
| `src/index.ts` | Add `migrate()` call |

---

## What Doesn't Change

- `src/config.ts` — WIKI_DIR already exists
- `src/repoSync.ts` — unchanged
- `src/plugins/` — unchanged
- `src/events/` — unchanged
- `src/utils/` — unchanged
- `tsconfig.json`, `package.json` — unchanged
- The existing `onboarding` plugin — unchanged

---

## No Slash Commands

All interactions are natural language:

| Intent | How |
|--------|-----|
| **Answer** | `@bot how does fingerprinting work?` → Q&A → wiki update |
| **Ingest** | `@bot write a wiki page about the safety model` → researches + files it |
| **Update** | `@bot the Honda page is wrong, it's a 2020 not 2019` → reads + rewrites |
| **Lint** | `@bot check the wiki for stale or contradictory pages` → reads + fixes |
