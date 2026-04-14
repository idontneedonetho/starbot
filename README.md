# StarBot 🌟

A lightweight, persistent Discord AI assistant for the [StarPilot](https://github.com/firestar5683/starpilot/tree/StarPilot) openpilot fork, powered by the [pi coding agent SDK](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

StarBot keeps a local shallow clone of the StarPilot repository up to date and spins up a read-only AI agent to intelligently answer questions about the codebase. It features zero-config automatic user memory, seamless conversation threading, and a pure mention-based interface—all perfectly packaged via Docker. No RAG pipelines or vector databases needed; the agent dynamically reads the real source code.

---

## Capabilities

- **Natural Mention Interface**: Simply ping the bot (e.g., `@BotName`) to ask a question. No slash commands required.
- **Continuous Conversations**: StarBot analyzes Discord's native reply chains to seamlessly maintain thread context.
- **Automatic User Memory**: An asynchronous LLM pipeline silently extracts and stores facts about your vehicle, hardware setup (like ZSS or pedal interceptors), and preferences in local JSON storage so you don't have to repeat yourself.
- **Automated Codebase Syncing**: Automatically clones and shallow-syncs the targeted StarPilot branch on an hourly cron schedule to save bandwidth and ensure accuracy.
- **Robust Message Chunking**: Intelligent code-aware chunking effortlessly handles responses longer than Discord's 2,000 character limit without breaking code blocks.
- **Zero-Trust Agent**: Agent sessions are isolated to specific questions and the repository is kept completely read-only.
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
_(The bot will instantly react with 👀 to let you know it's thinking, then sequentially output its answers, updating the initial reaction to ✅ upon completion)._

**Continuing a topic:**
Simply use Discord's native *Reply* feature to respond to one of the bot's messages, and it will automatically crawl up the reply chain to establish the conversation history and context.

**Leveraging Memory:**
If you ever mention *"I drive a 2017 Chevy Volt with a Comma 3X"*, StarBot will quietly extract and compress this detail in the background, automatically saving it to `./data/memories.json`. You can then comfortably ask *"where is the steering control logic for my car?"* entirely out of context down the line.

---

## System Architecture

```
Discord User
    │
    ▼ @mention or Native Reply
discord.js bot (src/bot.ts)
    │
    ├── Analyzes Message Thread History via Discord API
    ├── Loads Stored User Context from memory.ts (./data/memories.json)
    │
    ▼
pi-coding-agent inference (src/agent.ts)
    │
    ├── cwd = local clone (./repo-cache/starpilot) (Kept up-to-date by node-cron)
    ├── LLM dynamically loads/greps required code files via SDK read tools
    └── Generates concise answer based on source code findings
    │
    ▼
Background Extraction               Discord Message
(src/memory.ts via LLM)      ◄────  Intelligent text chunking (max 2000 chars)
Extracted facts saved               Reaction status cleanly updated (👀 -> ✅)
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
