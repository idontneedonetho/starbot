import { AuthStorage, ModelRegistry, createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession, type AgentSessionEventListener } from "@mariozechner/pi-coding-agent";
import fs from "fs";
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

async function createSession(cwd: string, systemPrompt: string, useTools: boolean, sessionPath: string | undefined, model = mainModel): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({ cwd, systemPromptOverride: () => systemPrompt });
  await loader.reload();

  let sessionManager: SessionManager;
  if (sessionPath && fs.existsSync(sessionPath) && fs.statSync(sessionPath).isFile()) {
    sessionManager = SessionManager.open(sessionPath);
  } else {
    sessionManager = SessionManager.create(cwd, sessionPath ?? "");
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

export async function askAboutRepo(botName: string, question: string, repoCwd: string, sessionPath: string | undefined, memoryContext = "", onProgress?: () => void): Promise<string> {
  if (!mainModel) throw new Error("No main model configured");
  const systemPrompt = buildSystemPrompt(botName);
  const session = await createSession(repoCwd, systemPrompt, true, sessionPath, mainModel);
  let answer = "";
  session.subscribe(createTextCollector((text) => { answer += text; onProgress?.(); }));
  const fullPrompt = memoryContext ? `${memoryContext}\n\n${question}` : question;
  try {
    await session.prompt(fullPrompt);
  } finally {
    session.dispose();
  }
  return answer.trim() || "I was unable to generate an answer. Please try again.";
}