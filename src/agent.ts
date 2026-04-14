import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { config } from "./config.js";

const SYSTEM_PROMPT = `\
You are StarBot, an expert assistant for the StarPilot project — a custom fork of comma.ai's openpilot
driving assistance system with special support for GM vehicles.

The StarPilot codebase is available in your working directory. When answering questions:
- Be concise and accurate.
- Cite specific files and line numbers when relevant (e.g. "see selfdrive/controls/controlsd.py").
- If asked about a feature, explain what it does, where the relevant code lives, and any key configuration.
- If you cannot find something, say so clearly rather than guessing.
- Do not modify any files — you are in read-only mode.
`;

/** A single prior Q&A exchange from a Discord reply chain. */
export type ConversationTurn = {
  question: string;
  answer: string;
};

/**
 * Formats prior conversation turns into a context block to prepend to the prompt.
 * Answers are capped to keep the prompt from ballooning on long exchanges.
 */
function formatHistory(history: ConversationTurn[]): string {
  if (!history.length) return "";
  const MAX_ANSWER_LEN = 800;
  const lines = ["[Prior conversation in this thread]"];
  for (const turn of history) {
    lines.push(`User: ${turn.question}`);
    const ans = turn.answer.length > MAX_ANSWER_LEN
      ? turn.answer.slice(0, MAX_ANSWER_LEN) + "…"
      : turn.answer;
    lines.push(`Assistant: ${ans}`);
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Asks the pi coding agent a question about the StarPilot codebase.
 * Each call creates an isolated in-memory session (no cross-question state).
 *
 * Context from the Discord reply chain and the user's memory profile are both
 * injected into the prompt before the current question.
 *
 * @param question       The user's current question.
 * @param repoCwd        Absolute path to the local StarPilot clone.
 * @param memoryContext  Optional per-user context (from memory.ts).
 * @param history        Optional prior turns from the reply chain (oldest first).
 * @returns              The agent's answer as a string.
 */
export async function askAboutRepo(
  question: string,
  repoCwd: string,
  memoryContext = "",
  history: ConversationTurn[] = []
): Promise<string> {
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(config.LLM_PROVIDER, config.LLM_API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage);

  const model = modelRegistry.find(config.LLM_PROVIDER, config.LLM_MODEL) ?? undefined;
  if (!model) {
    console.warn(
      `[agent] Model ${config.LLM_PROVIDER}/${config.LLM_MODEL} not found; pi will pick first available.`
    );
  }

  const loader = new DefaultResourceLoader({
    cwd: repoCwd,
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: repoCwd,
    model,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    tools: createReadOnlyTools(repoCwd),
    resourceLoader: loader,
  });

  let answer = "";
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      answer += event.assistantMessageEvent.delta;
    }
  });

  // Build the full prompt: memory context + thread history + current question
  const fullPrompt = [
    memoryContext,
    formatHistory(history),
    history.length
      ? `Current question: ${question}`  // make it clear this is a follow-up
      : question,
  ]
    .filter(Boolean)
    .join("");

  try {
    await session.prompt(fullPrompt);
  } finally {
    session.dispose();
  }

  return answer.trim() || "I was unable to generate an answer. Please try again.";
}
