# StarBot 🌟

A Discord bot that answers questions about the [StarPilot](https://github.com/firestar5683/starpilot/tree/StarPilot) openpilot fork, powered by the [pi coding agent SDK](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

The bot keeps a local shallow clone of the StarPilot repo up to date and spins up a read-only AI agent to answer each question — no RAG pipeline, no vector DB, just the agent reading the real source code.

---

## Features

- `/ask <question>` slash command
- `@StarBot <question>` mention support
- Auto-clones & hourly-syncs the StarPilot `StarPilot` branch
- Per-question isolated agent sessions (stateless, safe)
- Read-only tools — agent can never modify the repo
- Graceful timeout handling
- Long answers chunked into multiple embeds

---

## Prerequisites

- Node.js ≥ 20.6.0
- Git installed on the host
- A Discord application & bot token
- An LLM API key (Anthropic recommended)

---

## Setup

### 1. Clone this repo & install dependencies

```bash
git clone <this repo>
cd starbot
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CLIENT_ID` | ✅ | Application ID (same portal) |
| `LLM_API_KEY` | ✅ | Your LLM provider API key |
| `LLM_PROVIDER` | | Provider name (default: `anthropic`) |
| `LLM_MODEL` | | Model ID (default: `claude-sonnet-4-5`) |
| `STARPILOT_REPO_URL` | | Fork URL (default: firestar5683's repo) |
| `STARPILOT_BRANCH` | | Branch to track (default: `StarPilot`) |
| `REPO_CACHE_DIR` | | Where to clone locally (default: `./repo-cache/starpilot`) |
| `SYNC_CRON` | | Sync schedule (default: `0 * * * *` — hourly) |
| `ANSWER_TIMEOUT_SECONDS` | | Agent timeout (default: `90`) |
| `ALLOWED_CHANNEL_IDS` | | Comma-separated channel IDs to restrict bot to (empty = all) |

### 3. Register slash commands with Discord

Run this **once** after setting up your `.env`:

```bash
npm run register
```

This registers the `/ask` command globally (can take up to 1 hour to propagate, but usually instant in dev).

### 4. Invite the bot to your server

Build an invite URL in the Discord Developer Portal with these scopes:
- `bot`
- `applications.commands`

Required permissions:
- Send Messages
- Read Message History
- Embed Links
- Mention Everyone (for @mention responses)

### 5. Start the bot

**Development (with hot reload):**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

On first start, the bot will:
1. Shallow-clone the StarPilot repo (~few hundred MB)
2. Start a cron job to keep it synced
3. Connect to Discord

---

## Usage

### Slash command
```
/ask question: what GM vehicles does starpilot support?
/ask question: where is the longitudinal planner code?
/ask question: how does Always On Lateral work?
```

### Mention
```
@StarBot what python version does this use?
@StarBot explain the ZSS virtual steering sensor
```

---

## Architecture

```
Discord User
    │
    ▼ /ask or @mention
discord.js bot (src/bot.ts)
    │
    ├── defers reply ("Thinking…")
    │
    ▼
pi coding agent session (src/agent.ts)
    │
    ├── cwd = local StarPilot clone (read-only tools)
    ├── LLM API call → Claude Sonnet
    └── reads source files to answer
    │
    ▼
Discord embed reply
    │
    ▼
Local repo (repo-cache/starpilot)
    └── kept up to date by node-cron + simple-git
```

---

## Supported LLM Providers

The pi SDK supports many providers. Change `LLM_PROVIDER` and `LLM_MODEL` accordingly:

| Provider | `LLM_PROVIDER` | Example `LLM_MODEL` |
|---|---|---|
| Anthropic | `anthropic` | `claude-sonnet-4-5` |
| OpenAI | `openai` | `gpt-4o` |
| Google Gemini | `google` | `gemini-2.5-pro` |
| Groq | `groq` | `llama-3.3-70b-versatile` |

See [pi-mono providers docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) for the full list.
