import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  readOnlyTools,
  createCodingTools,
  createReadOnlyTools,
  type AgentSession,
  type AgentSessionEventListener,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
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

function createTextCollector(onText: (text: string) => void): AgentSessionEventListener {
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onText(event.assistantMessageEvent.delta);
    }
  };
}

const MAX_LOADER_CACHE_SIZE = 10;
const loaderCache: Map<string, DefaultResourceLoader> = new Map();

// Extension that injects per-user memory context before each agent turn.
const memoryExtension = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => {
    const userIdMatch = event.prompt.match(/\[user_id:(\d+)\]/);
    if (userIdMatch) {
      const userId = userIdMatch[1];
      const memory = await buildMemoryContext(userId, "User");
      const cleanPrompt = event.prompt.replace(new RegExp(`\\[user_id:${userId}\\]`), "").trim();
      
      if (memory) {
        return {
          systemPrompt: event.systemPrompt + "\n\n" + memory,
          prompt: cleanPrompt,
        };
      } else {
        return {
          prompt: cleanPrompt,
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

async function createSession(
  cwd: string,
  systemPrompt: string,
  tools: AgentTool[],
  sessionPath?: string,
  model = mainModel,
): Promise<AgentSession> {
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

  const { session } = await createAgentSession({
    cwd,
    model,
    sessionManager,
    authStorage,
    modelRegistry,
    tools: tools as any,
    resourceLoader: loader,
  });
  return session;
}

// Creates a minimal session with no extensions (used for internal LLM calls like memory extraction).
async function createRawSession(systemPrompt: string, tools: AgentTool[], model = mainModel): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    systemPromptOverride: () => systemPrompt,
    extensionFactories: [],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    sessionManager,
    authStorage,
    modelRegistry,
    tools: tools as any,
    resourceLoader: loader,
  });
  return session;
}

export async function singleTurnLlm(systemPrompt: string, userMessage: string, model = memoryModel ?? mainModel): Promise<string> {
  if (!model) throw new Error("No model configured for LLM operations");
  // Use a raw session — no memory extension needed for internal LLM calls.
  const session = await createRawSession(systemPrompt, readOnlyTools as AgentTool[], model);
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
  sessionPath: string | undefined,
  userId?: string,
  timeoutMs: number = 90000,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(botName, REPO_NAME, REPO_DESC);
  const session = await createSession(repoCwd, systemPrompt, readOnlyTools as AgentTool[], sessionPath, mainModel);
  let answer = "";

  let inactivityTimer: NodeJS.Timeout;
  let rejectTimeout!: (err: Error) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    inactivityTimer = setTimeout(
      () => reject(new Error("timeout")),
      timeoutMs,
    );
  });

  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => rejectTimeout(new Error("timeout")),
      timeoutMs,
    );
  };

  const unsubActivity = session.subscribe((event) => {
    if (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start") {
      resetTimer();
    }
  });
  const unsubText = session.subscribe(createTextCollector((text) => {
    answer += text;
    resetTimer();
  }));

  const fullPrompt = userId ? `[user_id:${userId}]\n\n${question}` : question;
  try {
    await Promise.race([session.prompt(fullPrompt), timeoutPromise]);
  } finally {
    clearTimeout(inactivityTimer!);
    unsubActivity();
    unsubText();
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
  onAnswerUpdate?: (fullAnswer: string) => void,
): Promise<string> {
  const timeout = timeoutMs ?? 120_000;
  const tools = [
    ...(createCodingTools(PLUGINS_DIR) as AgentTool[]),
    ...(createReadOnlyTools(BOT_SRC_DIR) as AgentTool[]),
  ];
  const session = await createSession(cwd, CREATE_PLUGIN_SYSTEM, tools, undefined, mainModel);
  let answer = "";

  // Inactivity timeout: resets whenever the agent produces an event.
  // Using Promise.race ensures the rejection actually reaches the caller (setInterval throw does not).
  let inactivityTimer: NodeJS.Timeout;
  let rejectTimeout!: (err: Error) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    inactivityTimer = setTimeout(
      () => reject(new Error(`Timeout after ${timeout / 1000}s of inactivity`)),
      timeout,
    );
  });

  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => rejectTimeout(new Error(`Timeout after ${timeout / 1000}s of inactivity`)),
      timeout,
    );
  };

  const unsubActivity = session.subscribe((event) => {
    if (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start") {
      resetTimer();
      onActivity?.();
    }
  });

  const unsubText = session.subscribe(createTextCollector((text) => {
    answer += text;
    onProgress?.(text);
    onAnswerUpdate?.(answer);
  }));

  try {
    await Promise.race([session.prompt(prompt), timeoutPromise]);
  } catch (err) {
    console.error("[createPlugin] Session error:", err);
    throw err;
  } finally {
    clearTimeout(inactivityTimer!);
    unsubActivity();
    unsubText();
    session.dispose();
  }

  return answer;
}