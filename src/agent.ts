import {
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
import { mainModel, authStorage, modelRegistry } from "./llm.js";
import { readUserWiki } from "./wiki.js";
import { config, REPO_NAME, REPO_DESC, PLUGINS_DIR, BOT_SRC_DIR } from "./config.js";
import { buildSystemPrompt, CREATE_PLUGIN_SYSTEM } from "./prompts.js";
import { createInactivityTimeout } from "./utils/timeout.js";

function createTextCollector(onText: (text: string) => void): AgentSessionEventListener {
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onText(event.assistantMessageEvent.delta);
    }
  };
}

const memoryExtension = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => {
    const userIdMatch = event.prompt.match(/\[user_id:(\d+)\]/);
    if (userIdMatch) {
      const userId = userIdMatch[1];
      const memory = await readUserWiki(userId);
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

async function createSession(
  cwd: string,
  systemPrompt: string,
  tools: AgentTool[],
  sessionPath?: string,
  model = mainModel,
): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => systemPrompt,
    extensionFactories: [memoryExtension],
  });

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

  const timeout = createInactivityTimeout(timeoutMs);

  const unsubActivity = session.subscribe((event) => {
    if (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start") {
      timeout.reset();
    }
  });
  const unsubText = session.subscribe(createTextCollector((text) => {
    answer += text;
    timeout.reset();
  }));

  const fullPrompt = userId ? `[user_id:${userId}]\n\n${question}` : question;
  try {
    await Promise.race([session.prompt(fullPrompt), timeout.promise]);
  } finally {
    timeout.clear();
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

  const inactivityTimeout = createInactivityTimeout(
    timeout,
    `Timeout after ${timeout / 1000}s of inactivity`,
  );

  const unsubActivity = session.subscribe((event) => {
    if (event.type === "turn_start" || event.type === "tool_execution_start" || event.type === "message_start") {
      inactivityTimeout.reset();
      onActivity?.();
    }
  });

  const unsubText = session.subscribe(createTextCollector((text) => {
    answer += text;
    onProgress?.(text);
    onAnswerUpdate?.(answer);
  }));

  try {
    await Promise.race([session.prompt(prompt), inactivityTimeout.promise]);
  } catch (err) {
    console.error("[createPlugin] Session error:", err);
    throw err;
  } finally {
    inactivityTimeout.clear();
    unsubActivity();
    unsubText();
    session.dispose();
  }

  return answer;
}
