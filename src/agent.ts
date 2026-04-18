import { AuthStorage, ModelRegistry, createAgentSession, DefaultResourceLoader, SessionManager, readOnlyTools, createCodingTools, createReadOnlyTools, type AgentSession, type AgentSessionEventListener, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { buildMemoryContext } from "./memory.js";
import { config, REPO_NAME, REPO_DESC, PLUGINS_DIR, BOT_SRC_DIR } from "./config.js";
import { buildSystemPrompt, CREATE_PLUGIN_SYSTEM } from "./prompts.js";

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

function getPluginTools(): AgentTool[] {
  return createCodingTools(PLUGINS_DIR) as AgentTool[];
}

function getBotTools(): AgentTool[] {
  return createReadOnlyTools(BOT_SRC_DIR) as AgentTool[];
}

function getRepoTools(): AgentTool[] {
  return readOnlyTools;
}

function createTextCollector(onText: (text: string) => void): AgentSessionEventListener {
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onText(event.assistantMessageEvent.delta);
    }
  };
}

const MAX_LOADER_CACHE_SIZE = 10;
const loaderCache: Map<string, DefaultResourceLoader> = new Map();

const memoryExtension = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => {
    const userIdMatch = event.prompt.match(/\[user_id:(\d+)\]/);
    if (userIdMatch) {
      const userId = userIdMatch[1];
      const memory = await buildMemoryContext(userId, "User");
      if (memory) {
        return {
          systemPrompt: event.systemPrompt + "\n\n" + memory,
          prompt: event.prompt.replace(`\[user_id:${userId}\]`, "").trim(),
        };
      }
    }
  });
};

function getLoader(cwd: string, systemPrompt: string, extensionFactory?: (pi: ExtensionAPI) => void): DefaultResourceLoader {
  const key = `${cwd}:${systemPrompt}`;
  if (loaderCache.has(key)) {
    return loaderCache.get(key)!;
  }
  
  if (loaderCache.size >= MAX_LOADER_CACHE_SIZE) {
    const firstKey = loaderCache.keys().next().value;
    if (firstKey) loaderCache.delete(firstKey);
  }
  
  const extensions = extensionFactory ? [extensionFactory, memoryExtension] : [memoryExtension];
  
  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => systemPrompt,
    extensionFactories: extensions,
  });
  loaderCache.set(key, loader);
  return loader;
}

async function createSession(cwd: string, systemPrompt: string, tools: AgentTool[], sessionPath?: string, model = mainModel): Promise<AgentSession> {
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

  const { session } = await createAgentSession({ cwd, model, sessionManager, authStorage, modelRegistry, tools: tools as any, resourceLoader: loader });
  return session;
}

export async function singleTurnLlm(systemPrompt: string, userMessage: string, model = memoryModel ?? mainModel): Promise<string> {
  if (!model) throw new Error("No model configured for LLM operations");
  const session = await createSession(process.cwd(), systemPrompt, getRepoTools(), undefined, model);
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
  const systemPrompt = buildSystemPrompt(botName, REPO_NAME, REPO_DESC);
  const session = await createSession(repoCwd, systemPrompt, getRepoTools(), sessionPath, mainModel);
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

export async function createPlugin(
  prompt: string,
  cwd: string,
  onProgress?: (text: string) => void,
  onActivity?: () => void,
  timeoutMs?: number,
  onAnswerUpdate?: (fullAnswer: string) => void
): Promise<string> {
  const systemPrompt = CREATE_PLUGIN_SYSTEM;

  const tools = [...getPluginTools(), ...getBotTools()];
  const session = await createSession(cwd, systemPrompt, tools, undefined, mainModel);
  let answer = "";
  let lastEventTime = Date.now();
  
  const unsubActivity = session.subscribe((event) => {
    if (onActivity) {
      if (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start") {
        lastEventTime = Date.now();
        onActivity();
      }
    }
  });
  
  session.subscribe(createTextCollector((text) => {
    answer += text;
    onProgress?.(text);
    onAnswerUpdate?.(answer);
  }));

  const timeout = timeoutMs || 120000;
  
  const timer = setInterval(() => {
    if (Date.now() - lastEventTime > timeout) {
      clearInterval(timer);
      session.dispose();
      throw new Error(`Timeout after ${timeout / 1000}s of inactivity`);
    }
  }, 5000);
  
  try {
    await session.prompt(prompt);
  } catch (err) {
    console.error("[createPlugin] Session error:", err);
    throw err;
  }
  
  clearInterval(timer);
  unsubActivity();
  session.dispose();
  
  return answer;
}