import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { config } from "./config.js";

// Shared singleton instances for LLM access.
// Avoids redundant instantiation across agent.ts and llm.ts.

export const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey(config.LLM_PROVIDER, config.LLM_API_KEY);

export const modelRegistry = ModelRegistry.create(authStorage);

export const mainModel =
  modelRegistry.find(config.LLM_PROVIDER, config.LLM_MODEL) ?? undefined;

if (!mainModel) {
  console.warn(
    `[providers] Model ${config.LLM_PROVIDER}/${config.LLM_MODEL} not found; pi will pick first available.`
  );
}
