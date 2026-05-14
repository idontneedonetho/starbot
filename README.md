# StarBot

A persistent Discord AI assistant for [StarPilot](https://github.com/firestar5683/starpilot/tree/StarPilot), powered by the [pi coding agent SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Features a hot-reloadable plugin system, an auto-synced repo clone, and a self-maintaining wiki knowledge base.

---

## Features

- **Mention interface** — ping the bot in any channel to ask a question
- **Thread-backed sessions** — each thread gets its own persistent agent session; continue conversations naturally
- **Plugin system** — hot-reloadable plugins can add slash commands (`command`) or event handlers (`events`). Admins create/modify plugins via `/manage` using natural language — an AI agent writes the code
- **Self-maintaining wiki** — every Q&A exchange is distilled into a structured markdown wiki (concepts, entities, user profiles) that future answers reference via `[[wiki-link]]`. The bot reads the wiki before touching source code, so knowledge accumulates over time
- **Auto-synced repo** — shallow-clones the target branch and syncs on a cron schedule with retry logic
- **Rate limiting & concurrency** — per-user rate limiter + semaphore-based queue with visual position indicators
- **Code-aware chunking** — splits long responses at Discord's 2000-char limit without breaking code blocks
- **Graceful shutdown** — SIGINT/SIGTERM handling, Docker health endpoint on `:3000/health`

---

## Prerequisites

- Git
- Docker & Docker Compose (recommended) **or** Node.js >= 20.6.0
- A Discord application with bot token
- An LLM API key

---

## Quickstart

### 1. Clone & configure

```bash
git clone <this repo>
cd starbot
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `LLM_API_KEY` at minimum.

### 2. Invite the bot

Create an invite URL in the [Discord Developer Portal](https://discord.com/developers/applications) with the `bot` scope and these permissions:

- Read Messages / View Channels
- Send Messages
- Read Message History
- Add Reactions

Enable the **Message Content** privileged intent in the Developer Portal.

### 3. Run

**Production (Docker):**
```bash
docker compose up -d --build
```

**Development (direct Node):**
```bash
npm install
npm run dev
```

---

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token |
| `LLM_PROVIDER` | `anthropic` | Provider name |
| `LLM_API_KEY` | — | API key |
| `LLM_MODEL` | `claude-sonnet-4-5` | Model ID |
| `CHEAP_LLM_PROVIDER` | _(main)_ | Optional cheaper provider for memory/wiki ops |
| `CHEAP_LLM_MODEL` | _(main)_ | Optional cheaper model |
| `REPO_NAME` | `StarPilot` | Display name for the tracked repo |
| `REPO_DESC` | _(see .env.example)_ | Short description shown in prompts |
| `STARPILOT_REPO_URL` | `https://github.com/firestar5683/starpilot` | Git remote |
| `STARPILOT_BRANCH` | `StarPilot` | Branch to track |
| `REPO_CACHE_DIR` | `./repo-cache/starpilot` | Local clone location |
| `SYNC_CRON` | `0 * * * *` | Cron expression for repo sync |
| `SESSION_DIR` | `./data/sessions` | Agent session storage |
| `PLUGINS_DIR` | `./data/plugins` | Plugin file directory |
| `BOT_SRC_DIR` | `./src` | Bot source directory (for agent context) |
| `WIKI_DIR` | `./data/wikis` | Wiki knowledge base directory |
| `ADMIN_USER_IDS` | _(none)_ | Comma-separated user IDs allowed to use `/manage` |
| `ALLOWED_CHANNEL_IDS` | _(all)_ | Comma-separated channel IDs to restrict the bot to |
| `ANSWER_TIMEOUT_SECONDS` | `90` | Max seconds per question (10–300) |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Rate limit window |
| `RATE_LIMIT_MAX` | `3` | Max questions per window per user |
| `MAX_CONCURRENT` | `2` | Max simultaneous agent inferences |
| `STALE_THRESHOLD_MS` | `7200000` | (2h) Warn if repo hasn't synced this long |
| `SYNC_MAX_RETRIES` | `3` | Git sync retries |
| `SYNC_RETRY_DELAY_MS` | `5000` | Base retry delay (exponential backoff) |

---

## Plugin System

Plugins are hot-reloadable `.js` files in `PLUGINS_DIR` (default `./data/plugins/`). You can organize them in subdirectories.

### Plugin structure

A plugin file exports one or both of:

```js
// Slash command
export const command = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with pong"),
  execute: async (interaction) => {
    await interaction.reply("Pong!");
  },
};

// Event handlers
export const events = {
  guildMemberAdd: async (client, member) => {
    console.log(`${member.user.tag} joined`);
  },
  messageCreate: async (client, message) => {
    // ...
  },
};
```

Supported event names: `ready`, `messageCreate`, `messageDelete`, `messageUpdate`, `reactionAdd`, `reactionRemove`, `threadCreate`, `threadDelete`, `threadUpdate`, `guildMemberAdd`, `guildMemberRemove`, `interactionCreate`.

### `/manage` command

Admins (users in `ADMIN_USER_IDS` or with `Administrator` permission) can create and modify plugins via natural language:

```
/manage prompt: create a command that says "Hello, world!"
/manage prompt: add a welcome message event handler plugin: welcome
```

The bot delegates to an AI agent that writes the plugin file, syntax-checks it with `node -c`, and hot-reloads it. Commands are synced to Discord automatically.

### Hot-reload internals

- Plugins are loaded with `import()` using `Date.now()` cache busting (`?t=...`)
- Each plugin's event handlers are indexed per-plugin so unloading removes only that plugin's handlers
- `node -c` validates syntax before any plugin is loaded

---

## Wiki Knowledge Base

Every Q&A exchange is automatically distilled into a persistent markdown wiki that the agent reads alongside source code. The wiki grows smarter with every interaction — no manual curation required.

### Lifecycle

```mermaid
flowchart LR
  subgraph Query[On question]
    A[User asks question] --> B[Agent reads SCHEMA.md]
    B --> C[Agent reads index.md]
    C --> D[Agent reads relevant wiki pages]
    D --> E[Agent reads repo source code]
    E --> F[Agent synthesizes answer<br>with [[wiki-link]] references]
  end

  F --> G[afterExchange]

  subgraph Ingest[After answering]
    G --> H[Raw interaction saved<br>to raw/threads/]
    H --> I[Wiki update agent triggered]
    I --> J[Reads raw thread]
    J --> K[Creates/updates concept,<br>entity, and user pages]
    K --> L[Cross-references pages<br>with [[wiki-link]]]
    L --> M[Updates index.md]
    M --> N[Appends to log.md]
  end

  N --> O[Future answers<br>read new pages]
  O -.-> B
```

### Three-layer architecture

```
wikis/                      # One wiki per bot deployment
├── SCHEMA.md               # Governance rules — read first
├── index.md                # Table of contents — updated on every change
├── log.md                  # Append-only operation log
├── concepts/               # Codebase concepts (fingerprinting, CAN bus, safety model)
├── entities/               # Physical things (car models, hardware, devices)
├── users/                  # Community member profiles
└── raw/threads/            # Immutable Q&A exchanges, one .md per thread
```

| Layer | Path | Editable? | Purpose |
|---|---|---|---|
| **Raw sources** | `raw/threads/` | No (immutable) | Full Q&A text for context |
| **The wiki** | `concepts/`, `entities/`, `users/` | Yes (LLM-maintained) | Curated, cross-referenced knowledge |
| **Schema** | `SCHEMA.md` | Yes (co-evolved) | Rules for structure, naming, operations |

### Page conventions

Every wiki page starts with YAML frontmatter:

```yaml
---
title: "Fingerprinting"
type: concept
created: 2026-05-01
updated: 2026-05-12
tags: [can-bus, identification, panda]
sources: [raw/threads/1493797593849790584.md]
---
```

- **Naming**: concepts/entities use PascalCase (`Fingerprinting.md`, `HyundaiSonata2020.md`), users use Discord IDs
- **Cross-references**: every page links to at least one other using `[[wiki-link]]` notation — no orphan pages
- **Contradictions**: if new info contradicts an existing page, a `## Conflicts` section is added instead of silent overwrite

### index.md

The table of contents the LLM reads first to navigate the wiki. Updated automatically after every ingest:

```markdown
## Concepts
- [[Fingerprinting]] — how StarPilot identifies car models via CAN messages
- [[SafetyModel]] — the openpilot safety model and stock ECU limitations

## Entities
- [[CommaThree]] — Snapdragon-based comma device
- [[HyundaiSonata2020]] — 2020 Hyundai Sonata, common test platform
```

### log.md

Append-only record of every wiki operation, parsed later for audit/recovery:

```
## [2026-05-12] ingest | Created [[Fingerprinting]] from thread 1493797593849790584
## [2026-05-12] query  | Answered "what vehicles are supported?" from [[CarParams]]
## [2026-05-12] update | Updated [[HyundaiSonata2020]] with new CAN fingerprint
```

Prefixes: `ingest`, `update`, `query`, `lint`.

### Agent integration

- **On question**: the Q&A agent reads `SCHEMA.md` and `index.md` first to orient itself, then loads relevant wiki pages before touching source code. Answers include `[[wiki-link]]` references back to the wiki.
- **After answer**: a second LLM agent (`runWikiUpdate`) reads the raw exchange and ingests new knowledge into the wiki — creating pages, cross-referencing, updating index and log.
- **Over time**: the wiki accumulates structured knowledge about the codebase. The agent relies on it increasingly, reducing redundant reads of the same source files.

---

## Usage

Mention the bot in any allowed channel:

```
@StarBot what vehicles does StarPilot support?
```

**Reaction flow:**

| Reaction | Meaning |
|---|---|
| 👀 | Received, waiting to start |
| 1, 2, ... 🔟 | Queue position (shown when MAX_CONCURRENT exceeded) |
| ⏳ | Processing |
| ✅ | Complete |
| ❌ | Error or timeout |

Reply to the bot's messages in the thread to continue the conversation — the agent remembers context from the full thread session.

---

## Architecture

```
Discord
   │
   ▼ @mention
bot.ts (discord.js client)
   ├── rate limiter & semaphore (limits.ts)
   ├── thread session (memory.ts → ./data/sessions/)
   │
   ├── handleQuestion() ──► agent.ts (Q&A)
   │   ┌──────────────────────────────────────┐
   │   │  1. Read SCHEMA.md + index.md        │
   │   │  2. Read relevant wiki pages         │
   │   │  3. Read source code (repo-cache/)   │
   │   │  4. Synthesize answer w/ [[links]]   │
   │   └──────────────────────────────────────┘
   │   cwd = repo-cache/starpilot (synced by repoSync.ts)
   │
   ├── chunkAnswer() ──► chunking.ts → reply in thread
   │
   └── afterExchange() ──► wiki.ts
       │   save raw interaction → raw/threads/
       │   trigger wiki update agent
       ▼
   agent.ts (runWikiUpdate)
       ┌──────────────────────────────────────┐
       │  1. Read raw thread                   │
       │  2. Create/update wiki pages          │
       │  3. Cross-reference w/ [[wiki-link]]  │
       │  4. Update index.md + log.md          │
       └──────────────────────────────────────┘

/plugins/loader.ts  ← loads plugin-*.js files from data/plugins/
/plugins/manager.ts ← /manage command (admin-only AI plugin creation)

Events flow:
  Discord event → handler.ts (maps event names → Events.* constants)
                → plugin event handlers (registered by loader.ts)
```

### File structure

```
src/
├── index.ts            # Entry point, cron, health server
├── bot.ts              # Discord client, message/interaction handlers
├── config.ts           # Envalid config schema + typed exports
├── llm.ts              # LLM provider/model registry
├── agent.ts            # pi-coding-agent session wrappers (Q&A, plugin creation, wiki update)
├── prompts.ts          # System prompt templates
├── memory.ts           # Thread session path management
├── repoSync.ts         # Git clone/sync with retry + staleness checks
├── wiki.ts             # Wiki directory management, raw interaction saving
├── events/
│   └── handler.ts      # Maps plugin event names to discord.js Events.*
├── plugins/
│   ├── loader.ts       # Plugin hot-load/unload, command sync with Discord
│   └── manager.ts      # /manage slash command, admin check, AI agent orchestration
└── utils/
    ├── limits.ts       # Rate limiter + concurrency semaphore with queue position
    ├── timeout.ts      # Configurable inactivity timeout with reset
    └── chunking.ts     # Discord-safe text chunking (preserves code blocks)
```

---

## Supported LLM Providers

StarBot uses the `pi-coding-agent` SDK. See the [providers documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) for all supported options. Common choices:

| Provider | `LLM_PROVIDER` | Example `LLM_MODEL` |
|---|---|---|
| Anthropic | `anthropic` | `claude-sonnet-4-5` |
| OpenAI | `openai` | `gpt-4o` |
| Google Gemini | `google` | `gemini-2.5-pro` |
| Groq | `groq` | `llama-3.3-70b-versatile` |

---

## Docker

```bash
docker compose up -d --build
```

The image uses a multi-stage build. Volumes are mounted for `./data` (plugins, sessions, wiki) and `./repo-cache` (git clone). A healthcheck pings `:3000/health`. Memory is capped at 512 MB, CPU at 0.5 cores.
