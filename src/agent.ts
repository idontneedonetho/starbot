import {
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { authStorage, modelRegistry, mainModel } from "./providers.js";

const buildSystemPrompt = (botName: string) => `\
You are ${botName}, an expert assistant for the StarPilot project — a custom fork of comma.ai's openpilot
driving assistance system with special support for GM vehicles.

The StarPilot codebase is available in your working directory. When answering questions:
- Be concise and accurate.
- Cite specific files and line numbers when relevant (e.g. "see selfdrive/controls/controlsd.py").
- If asked about a feature, explain what it does, where the relevant code lives, and any key configuration.
- If you cannot find something, say so clearly rather than guessing.
- Do not modify any files — you are in read-only mode.
`;

// A single turn from a conversation thread
export type ConversationTurn = {
  question: string;
  answer: string;
};

// Formats recent thread history into string for the prompt
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



export async function askAboutRepo(
  botName: string,
  question: string,
  repoCwd: string,
  memoryContext = "",
  history: ConversationTurn[] = [],
  onProgress?: () => void
): Promise<string> {
  const model = mainModel;

  const loader = new DefaultResourceLoader({
    cwd: repoCwd,
    systemPromptOverride: () => buildSystemPrompt(botName),
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
      onProgress?.();
    }
  });

  // Assemble full prompt block
  const fullPrompt = [
    memoryContext,
    formatHistory(history),
    history.length
      ? `Current question: ${question}`
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
