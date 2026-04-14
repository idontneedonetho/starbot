# StarBot 🌟

A lightweight, persistent Discord AI assistant for the [StarPilot](https://github.com/firestar5683/starpilot/tree/StarPilot) openpilot fork, powered by the [pi coding agent SDK](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

StarBot keeps a local shallow clone of the StarPilot repository up to date and spins up a read-only AI agent to intelligently answer questions about the codebase. It features zero-config automatic user memory, seamless conversation threading, and a pure mention-based interface—all perfectly packaged via Docker. No RAG pipelines or vector databases needed; the agent dynamically reads the real source code.

---

## Capabilities

- **Natural Mention Interface**: Simply ping the bot (e.g., `@BotName`) to ask a question. No slash commands required.
- **Persistent Thread Sessions**: Each Discord thread gets its own persistent pi-coding-agent session. Continue the conversation naturally - the agent remembers previous messages in that thread.
- **Automatic User Memory**: An asynchronous LLM pipeline silently extracts and stores facts about your vehicle, hardware setup (like ZSS or pedal interceptors), and preferences in local SQLite storage so you don't have to repeat yourself.
- **Automated Codebase Syncing**: Automatically clones and shallow-syncs the targeted StarPilot branch on an hourly cron schedule to save bandwidth and ensure accuracy.
- **Robust Message Chunking**: Intelligent code-aware chunking effortlessly handles responses longer than Discord's 2,000 character limit without breaking code blocks.
- **Session Cleanup**: When a Discord thread is deleted, the corresponding session file is automatically removed.
- **Production-Ready Docker**: Features a lightweight multi-stage Docker build with graceful process stop/shutdown built-in.

---

## Prerequisites

- Git installed on the host
- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/) (Recommended for production)
- **OR** Node.js ≥ 20.6.0 (For manual/dev execution)
- A Discord application & bot token
- An LLM API key (Anthropic recommended)

---

## Quickstart Setup

### 1. Clone & Configure

```bash
git clone <this repo>
cd starbot
cp .env.example .env
```

Fill in the required values in your `.env` file:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CLIENT_ID` | ✅ | Application ID (same portal) |
| `LLM_API_KEY` | ✅ | Your LLM provider API key |
| `LLM_PROVIDER` | | Provider name (default: `anthropic`) |
| `LLM_MODEL` | | Model ID (default: `claude-sonnet-4-5`) |
| `CHEAP_LLM_PROVIDER` | | Optional cheaper provider for memory operations |
| `CHEAP_LLM_MODEL` | | Optional cheaper model ID (e.g., `claude-haiku-3-5`) |
| `STARPILOT_REPO_URL` | | Fork URL (default: `https://github.com/firestar5683/starpilot`) |
| `STARPILOT_BRANCH` | | Branch to track (default: `StarPilot`) |
| `SESSION_DIR` | | Session storage directory (default: `./data/sessions`) |
| `ANSWER_TIMEOUT_SECONDS` | | Agent inference timeout (default: `90`) |

### 2. Invite the bot to your server
Build an invite URL in the Discord Developer Portal with the `bot` scope.

**Required Bot Permissions:**
- Read Messages/View Channels
- Send Messages
- Read Message History
- Add Reactions (Used for 👀 / ✅ / ❌ status updates)

*Note: You must also explicitly turn on the `Message Content` privileged intent on the Developer Portal.*

### 3. Start StarBot (Production via Docker)

The easiest and recommended way to deploy is using Docker Compose:

```bash
docker compose up -d --build
```
This handles the multi-stage build, mapping out `./data/` for the persistent user memory state and `./repo-cache/` for StarPilot's source code cache.

### 4. Direct Node Execution (For Development)

If you prefer to run the system natively while hacking on the bot's code:
```bash
npm install
npm run dev
```

---

## Usage Examples

Simply mention the bot (using its name or server nickname) to initialize an interaction:
```text
@BotName what GM vehicles does starpilot currently support?
```
_(The bot will instantly react with 👀 to let you know it's thinking. If there's a queue, it shows position (1⃣, 2⃣...). While processing, it shows ⏳. When complete, it updates to ✅.)_

**Queue & Concurrency:**
- The bot can process up to 2 questions simultaneously
- If there's a queue, users see their position (1⃣, 2⃣, etc.)
- While processing, the reaction changes to ⏳ (hourglass)
- On completion, it shows ✅

**Continuing a topic:**
Simply reply to one of the bot's messages in the same thread. The agent will remember the entire conversation in that thread via persistent sessions.

**Leveraging Memory:**
If you ever mention *"I drive a 2017 Chevy Volt with a Comma 3X"*, StarBot will quietly extract and compress this detail in the background, automatically saving it to a local SQLite database (`./data/memories.db`). You can then comfortably ask *"where is the steering control logic for my car?"* entirely out of context down the line.

---

## System Architecture

```
Discord User
    │
    ▼ @mention in thread
discord.js bot (src/bot.ts)
    │
    ├── Get/create session for thread (./data/sessions/<threadId>.jsonl)
    ├── Load user facts from memory.ts (SQLite)
    ├── Check queue position (1⃣, 2⃣...) if waiting
    │
    ▼
pi-coding-agent inference (src/agent.ts)
    │
    ├── cwd = local clone (./repo-cache/starpilot) (Kept up-to-date by node-cron)
    ├── Session persists conversation history in JSONL file
    ├── LLM dynamically loads/greps required code files via SDK read tools
    └── Generates concise answer based on source code findings
    │
    ▼
Reaction Flow: 👀 → (queue position) → ⏳ → ✅
User facts saved to SQLite     Message delivered in chunks
```

### File Structure

```
src/
├── index.ts          # Entry point, health server, cron jobs
├── bot.ts            # Discord client, message handlers
├── agent.ts          # pi-coding-agent session wrapper + LLM providers
├── config.ts        # Environment configuration
├── memory.ts        # SQLite user profiles & thread sessions
├── prompts.ts       # LLM system prompts
├── repoSync.ts      # Git clone/sync with retry logic
└── utils/
    ├── limits.ts    # npm packages (semaphore + rate limiter)
    └── chunking.ts  # Discord-safe text chunking
```

---

## Supported LLM Providers

StarBot leverages the open-source `pi-coding-agent` SDK, which transparently interfaces with top-tier providers natively out of the box:

| Provider | `LLM_PROVIDER` | Example `LLM_MODEL` |
|---|---|---|
| Anthropic | `anthropic` | `claude-sonnet-4-5` |
| OpenAI | `openai` | `gpt-4o` |
| Google Gemini | `google` | `gemini-2.5-pro` |
| Groq | `groq` | `llama-3.3-70b-versatile` |

See the [pi-mono providers documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) for full configuration instructions and supported keys.
