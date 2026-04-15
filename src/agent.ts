import { AuthStorage, ModelRegistry, createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession, type AgentSessionEventListener, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMemoryContext } from "./memory.js";
import { config } from "./config.js";
import { buildSystemPrompt } from "./prompts.js";

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey(config.LLM_PROVIDER, config.LLM_API_KEY);

const modelRegistry = ModelRegistry.create(authStorage);

const mainModel = modelRegistry.find(config.LLM_PROVIDER, config.LLM_MODEL);

const memoryModel = config.CHEAP_LLM_PROVIDER && config.CHEAP_LLM_MODEL
  ? modelRegistry.find(config.CHEAP_LLM_PROVIDER, config.CHEAP_LLM_MODEL) ?? mainModel
  : mainModel;

if (!mainModel) {
  console.warn(`[agent] Model ${config.LLM_PROVIDER}/${config.LLM_MODEL} not found; pi will pick first available.`);
}

if (config.CHEAP_LLM_PROVIDER && config.CHEAP_LLM_MODEL && !memoryModel) {
  console.warn(`[agent] Cheap model ${config.CHEAP_LLM_PROVIDER}/${config.CHEAP_LLM_MODEL} not found; falling back to main model.`);
}

function createTextCollector(onText: (text: string) => void): AgentSessionEventListener {
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onText(event.assistantMessageEvent.delta);
    }
  };
}

const loaderCache = new Map<string, DefaultResourceLoader>();

const memoryExtension = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => {
    const userIdMatch = event.prompt.match(/\[user_id:(\d+)\]/);
    if (userIdMatch) {
      const userId = userIdMatch[1];
      const memory = await buildMemoryContext(userId, "User");
      if (memory) {
        return {
          systemPrompt: event.systemPrompt + "\n\n" + memory,
          prompt: event.prompt.replace(`[user_id:${userId}]`, "").trim(),
        };
      }
    }
  });
};

function getLoader(cwd: string, systemPrompt: string): DefaultResourceLoader {
  const key = `${cwd}:${systemPrompt}`;
  if (!loaderCache.has(key)) {
    const loader = new DefaultResourceLoader({
      cwd,
      systemPromptOverride: () => systemPrompt,
      extensionFactories: [memoryExtension],
    });
    loaderCache.set(key, loader);
  }
  return loaderCache.get(key)!;
}

async function createSession(cwd: string, systemPrompt: string, useTools: boolean, sessionPath: string | undefined, model = mainModel): Promise<AgentSession> {
  const loader = getLoader(cwd, systemPrompt);
  await loader.reload();

  let sessionManager: SessionManager;
  if (sessionPath) {
    try {
      const sessions = await SessionManager.list(cwd, sessionPath);
      if (sessions.length > 0) {
        const mostRecent = sessions[sessions.length - 1];
        sessionManager = SessionManager.open(mostRecent.path, sessionPath);
      } else {
        sessionManager = SessionManager.create(cwd, sessionPath);
      }
    } catch {
      sessionManager = SessionManager.create(cwd, sessionPath);
    }
  } else {
    sessionManager = SessionManager.inMemory();
  }

  const { session } = await createAgentSession({ cwd, model, sessionManager, authStorage, modelRegistry, tools: useTools ? undefined : [], resourceLoader: loader });
  return session;
}

export async function singleTurnLlm(systemPrompt: string, userMessage: string, model = memoryModel ?? mainModel): Promise<string> {
  if (!model) throw new Error("No model configured for LLM operations");
  const session = await createSession(process.cwd(), systemPrompt, false, undefined, model);
  let result = "";
  session.subscribe(createTextCollector((text) => { result += text; }));
  try {
    await session.prompt(userMessage);
  } finally {
    session.dispose();
  }
  return result.trim();
}

export async function askAboutRepo(botName: string, question: string, repoCwd: string, sessionPath: string | undefined, userId?: string, onProgress?: () => void, onActivity?: () => void): Promise<string> {
  const systemPrompt = buildSystemPrompt(botName);
  const session = await createSession(repoCwd, systemPrompt, true, sessionPath, mainModel);
  let answer = "";
  const unsubActivity = session.subscribe((event) => {
    if (onActivity && (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start")) {
      onActivity();
    }
  });
  session.subscribe(createTextCollector((text) => { answer += text; onProgress?.(); }));
  const fullPrompt = userId ? `[user_id:${userId}]\n\n${question}` : question;
  try {
    await session.prompt(fullPrompt);
  } finally {
    unsubActivity();
    session.dispose();
  }
  return answer.trim() || "I was unable to generate an answer. Please try again.";
}