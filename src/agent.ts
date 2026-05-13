import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
  type AgentSession,
  type AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";
import { mainModel, authStorage, modelRegistry } from "./llm.js";
import { REPO_NAME, REPO_DESC, WIKI_DIR } from "./config.js";
import { buildSystemPrompt, CREATE_PLUGIN_SYSTEM } from "./prompts.js";
import { WIKI_UPDATE_SYSTEM } from "./wiki.js";
import { createInactivityTimeout } from "./utils/timeout.js";

function createTextCollector(onText: (text: string) => void): AgentSessionEventListener {
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onText(event.assistantMessageEvent.delta);
    }
  };
}

async function createSession(
  cwd: string,
  systemPrompt: string,
  toolNames: string[],
  sessionPath?: string,
  model = mainModel,
): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    extensionFactories: [],
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
    tools: toolNames,
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
  const systemPrompt = buildSystemPrompt(botName);
  const session = await createSession(repoCwd, systemPrompt, ["read", "grep", "find", "ls"], sessionPath, mainModel);
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
  const session = await createSession(cwd, CREATE_PLUGIN_SYSTEM, ["read", "bash", "edit", "write", "grep", "find", "ls"], undefined, mainModel);
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

export async function runWikiUpdate(exchange: { threadId: string; userId: string; question: string; answer: string }): Promise<void> {
  const session = await createSession(WIKI_DIR, WIKI_UPDATE_SYSTEM, ["read", "write", "edit", "grep", "find", "ls"]);
  const prompt = [
    `A Q&A exchange just happened.`,
    `Thread ID: ${exchange.threadId}`,
    `User ID: ${exchange.userId}`,
    `Question: ${exchange.question}`,
    `Answer: ${exchange.answer}`,
    ``,
    `The raw conversation is at raw/threads/${exchange.threadId}.md if you need context.`,
    `Go read the wiki and update it appropriately.`,
  ].join("\n");
  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }
}
