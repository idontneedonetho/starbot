import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  readOnlyTools,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "./config.js";

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey(config.LLM_PROVIDER, config.LLM_API_KEY);

const modelRegistry = ModelRegistry.create(authStorage);
export const mainModel = modelRegistry.find(config.LLM_PROVIDER, config.LLM_MODEL);

export const memoryModel = config.CHEAP_LLM_PROVIDER && config.CHEAP_LLM_MODEL
  ? modelRegistry.find(config.CHEAP_LLM_PROVIDER, config.CHEAP_LLM_MODEL) ?? mainModel
  : mainModel;

export { authStorage, modelRegistry };

if (!mainModel) {
  console.warn(`[llm] Model ${config.LLM_PROVIDER}/${config.LLM_MODEL} not found; pi will pick first available.`);
}

export async function singleTurnLlm(systemPrompt: string, userMessage: string, model = memoryModel ?? mainModel): Promise<string> {
  if (!model) throw new Error("No model configured for LLM operations");
  const session = await createRawSession(systemPrompt, readOnlyTools as AgentTool[], model);
  let result = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      result += event.assistantMessageEvent.delta;
    }
  });
  try {
    await session.prompt(userMessage);
  } finally {
    session.dispose();
  }
  return result.trim();
}

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
