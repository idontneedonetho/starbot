# StarPilot Discord Bot

StarPilot is a Discord bot designed for the StarPilot community to streamline identity onboarding, facilitate structured report submissions (bugs and feedback), and provide intelligent wiki-based support through RAG (Retrieval-Augmented Generation).

## 🚀 Features

- **🎭 Identity Onboarding**: A dedicated button allows members to set their server nickname and primary vehicle, ensuring a consistent and identifiable community.
- **🐛 Structured Reporting**: Integrated with Discord Forum channels, the bot provides a streamlined way for users to submit:
  - **Bugs**: Requires a Route ID for efficient troubleshooting.
  - **Feedback**: For general community suggestions.
  - **Feature Requests**: To help shape the future of StarPilot.
- **📚 Intelligent Wiki Search**: Mention the bot in any message to search the community wiki. It uses high-performance embedding and reranking models to provide relevant answers directly in the chat.

## 🛠️ Tech Stack

- **Language**: TypeScript
- **Bot Framework**: [discord.js](https://discord.js.org/)
- **AI/ML**: [@huggingface/transformers](https://github.com/huggingface/transformers.js) for embeddings and reranking.
- **Search Engine**: [minisearch](https://github.com/lucaong/minisearch) for fast local searching.
- **Runtime**: Node.js

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
- A Discord Bot Token (from the [Discord Developer Portal](https://discord.com/developers/applications))

## ⚙️ Installation & Setup

### 🐳 Using Docker (Recommended)

The easiest way to run StarPilot is using Docker Compose.

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd starbot
   ```

2. **Configure Environment Variables:**
   Create a `.env` file in the root directory and populate it with your configuration:

   ```env
   DISCORD_TOKEN=your_discord_bot_token
   GUILD_ID=your_server_id
   IDENTIFICATION_CHANNEL_ID=channel_id_for_identity_button
   FORUM_CHANNEL_ID=forum_channel_id_for_reports
   ROUTES_CHANNEL_ID=channel_id_for_routes_information
   VERIFIED_ROLE=role_id_for_verified_members

   # Optional: Wiki configuration
   WIKI_CLONE_URL=https://github.com/StarPilot-Docs/docs.git
   WIKI_CLONE_PATH=data/docs
   ```

3. **Start the bot:**
   ```bash
   docker compose up -d
   ```

### 🛠️ Local Development

If you prefer to run the bot directly on your machine:

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd starbot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory (same as the Docker setup above).

4. **Run in development mode:**
   ```bash
   npm run dev
   ```

5. **Run in production mode:**
   ```bash
   npm run build
   npm start
   ```

## 🚀 Running the Bot

### Development Mode
Use `tsx` to run the bot with hot-reloading:
```bash
npm run dev
```

### Production Mode
First, build the project, then start it:
```bash
npm run build
npm start
```

## 🔍 Wiki Search Details

The bot's wiki search works by:
1. Cloning the specified wiki repository on startup.
2. Parsing the markdown files.
3. Generating embeddings for the content using Hugging Face transformers.
4. Creating a searchable index.
5. When mentioned, the bot performs a semantic search to find the most relevant context and returns it to the user.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

[Specify License Here]
