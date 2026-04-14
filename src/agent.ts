import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEventListener,
} from "@mariozechner/pi-coding-agent";
import { authStorage, modelRegistry, mainModel, memoryModel } from "./providers.js";
import { buildSystemPrompt, formatHistory } from "./prompts/agent.js";

export type ConversationTurn = {
  question: string;
  answer: string;
};

function createTextCollector(onText: (text: string) => void): AgentSessionEventListener {
  return (event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      onText(event.assistantMessageEvent.delta);
    }
  };
}

async function createSession(
  cwd: string,
  systemPrompt: string,
  useTools: boolean,
  model = mainModel
): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    model,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    tools: useTools ? undefined : [],
    resourceLoader: loader,
  });

  return session;
}

export async function singleTurnLlm(
  systemPrompt: string,
  userMessage: string,
  model = memoryModel ?? mainModel
): Promise<string> {
  if (!model) {
    throw new Error("No model configured for LLM operations");
  }
  const session = await createSession(process.cwd(), systemPrompt, false, model);

  let result = "";
  session.subscribe(createTextCollector((text) => { result += text; }));

  try {
    await session.prompt(userMessage);
  } finally {
    session.dispose();
  }

  return result.trim();
}

export async function askAboutRepo(
  botName: string,
  question: string,
  repoCwd: string,
  memoryContext = "",
  history: ConversationTurn[] = [],
  onProgress?: () => void
): Promise<string> {
  if (!mainModel) {
    throw new Error("No main model configured");
  }
  const systemPrompt = buildSystemPrompt(botName);
  const session = await createSession(repoCwd, systemPrompt, true, mainModel);

  let answer = "";
  session.subscribe(createTextCollector((text) => {
    answer += text;
    onProgress?.();
  }));

  const fullPrompt = [
    memoryContext,
    formatHistory(history),
    history.length ? `Current question: ${question}` : question,
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