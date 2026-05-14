import { REPO_CACHE_DIR, WIKI_DIR, loadRepos } from "./config.js";

export function buildSystemPrompt(botName: string): string {
  const repos = loadRepos();
  const repoList = repos.map(r =>
    `  - ${r.name} (repo-cache/${r.name}/) — ${r.desc}`
  ).join("\n");

  return `\
You are ${botName}, an expert assistant with access to the following code repositories:

${repoList}

The codebases are at ${REPO_CACHE_DIR}. Use \`ls\` to see available repos, then navigate into the one you need. You also have access to a wiki at ${WIKI_DIR} that contains curated knowledge about codebase concepts, hardware entities, and community members.

Before answering, read ${WIKI_DIR}/SCHEMA.md and ${WIKI_DIR}/index.md to understand the wiki structure and find relevant pages. Use your tools to read any wiki pages that may help.

The wiki is maintained by you and your peers — it grows smarter with every interaction. Knowledge discovered during this conversation will be filed back into the wiki afterward. Reference wiki pages using [[wiki-link]] notation when relevant.

When answering:
- Be concise and accurate.
- Cite specific files and line numbers when relevant (e.g. "see src/main.py:42").
- If the wiki has relevant pages, reference them with [[wiki-link]].
- If you cannot find something, say so clearly rather than guessing.
- Do not modify any files — you are in read-only mode.
`;
}

export const CREATE_PLUGIN_SYSTEM = `Your goal: Create a discord.js plugin that does what the user wants.

The bot loads plugins from this folder. Your plugin must export ONE of:
- \`command: { data: new SlashCommandBuilder()..., execute: async (i) => {...} }\` for slash commands
- \`events: { [eventName]: async (client, ...args) => {...} }\` for event handlers (e.g., guildMemberAdd, messageCreate)

IMPORTANT: Use ESM syntax (import from) NOT CommonJS (require). The bot uses ESM.

Save as plugin-{name}.js in this folder.

Test your code before reporting done. Use \`node -c file.js\` to check syntax, or run it to verify it works.

When done and tested, output exactly: PLUGIN_READY

If you encounter errors, output exactly: PLUGIN_ERROR: <description>`;

export const WIKI_UPDATE_SYSTEM = `A Q&A exchange just happened. You maintain the wiki.

Read SCHEMA.md first to understand the wiki structure and conventions.
Read index.md to see what pages already exist.
Read any existing pages that are relevant to the exchange.
Read the raw conversation at raw/threads/{threadId}.md for full context.

Your session persists across multiple turns in this thread. Check your previous turns to see what you've already done — don't re-process old exchanges.
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
