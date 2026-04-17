import { AuthStorage, ModelRegistry, createAgentSession, DefaultResourceLoader, SessionManager, readOnlyTools, type AgentSession, type AgentSessionEventListener, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMemoryContext } from "./memory.js";
import { config, REPO_NAME, REPO_DESC } from "./config.js";
import { buildSystemPrompt } from "./prompts.js";
import { PLUGIN_TIMEOUT_SECONDS } from "./config.js";

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

async function createSession(cwd: string, systemPrompt: string, useTools: boolean, extensionFactory?: (pi: ExtensionAPI) => void, sessionPath?: string, model = mainModel): Promise<AgentSession> {
  const loader = getLoader(cwd, systemPrompt, extensionFactory);
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

  const { session } = await createAgentSession({ cwd, model, sessionManager, authStorage, modelRegistry, tools: useTools ? readOnlyTools : [], resourceLoader: loader });
  return session;
}

export async function singleTurnLlm(systemPrompt: string, userMessage: string, model = memoryModel ?? mainModel): Promise<string> {
  if (!model) throw new Error("No model configured for LLM operations");
  const session = await createSession(process.cwd(), systemPrompt, false, undefined, undefined, model);
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
  const session = await createSession(repoCwd, systemPrompt, true, undefined, sessionPath, mainModel);
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

const PLUGIN_TIMEOUT_MS = PLUGIN_TIMEOUT_SECONDS * 1000;

export async function generatePlugin(prompt: string): Promise<string> {
  const systemPrompt = `You are StarBot's plugin generator. Generate Discord capability code.

Respond with TWO code blocks:
1. Plugin code (JavaScript with module.exports)
2. Test code

Plugin must export:
{ command: { data: new SlashCommandBuilder()..., execute: async (i) => {...} } }

Test must: require plugin, call execute, print TEST_PASSED on success, process.exit(1) on failure.`;

  const session = await createSession(process.cwd(), systemPrompt, true, undefined, undefined, mainModel);
  
  let answer = "";
  let lastEventTime = Date.now();
  
  const unsub = session.subscribe((event) => {
    if (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start") {
      lastEventTime = Date.now();
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      answer += event.assistantMessageEvent.delta;
    }
  });
  
  const timer = setInterval(() => {
    if (Date.now() - lastEventTime > PLUGIN_TIMEOUT_MS) {
      clearInterval(timer);
      session.dispose();
      throw new Error("Timeout after 2 minutes");
    }
  }, 5000);
  
  try {
    await session.prompt("Generate the plugin code now.");
  } catch (err) {
    console.error("[plugin] Session error:", err);
  }
  
  clearInterval(timer);
  unsub();
  session.dispose();
  
  return answer;
}