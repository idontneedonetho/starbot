import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { config } from "./config.js";

/**
 * Creates a minimal, single-turn LLM session (no tools, in-memory).
 * System prompt is passed via DefaultResourceLoader override.
 * Used for memory extraction and compression — not for Q&A.
 */
export async function singleTurnLlm(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(config.LLM_PROVIDER, config.LLM_API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(config.LLM_PROVIDER, config.LLM_MODEL) ?? undefined;

  // System prompt injected via resource loader (the only supported path in pi SDK)
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model,
    tools: [],          // no tools — pure text generation
    resourceLoader: loader,
  });

  let result = "";
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
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
