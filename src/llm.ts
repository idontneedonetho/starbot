import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { authStorage, modelRegistry, mainModel } from "./providers.js";

/** Executes a single-turn text completion without tools */
export async function singleTurnLlm(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: mainModel,
    tools: [],
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
