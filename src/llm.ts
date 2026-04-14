import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { authStorage, modelRegistry, mainModel } from "./providers.js";

/**
 * Creates a minimal, single-turn LLM session (no tools, in-memory).
 * System prompt is passed via DefaultResourceLoader override.
 * Used for memory extraction and compression — not for Q&A.
 */
export async function singleTurnLlm(
  systemPrompt: string,
  userMessage: string
): Promise<string> {


  // System prompt injected via resource loader (the only supported path in pi SDK)
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: mainModel,
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
