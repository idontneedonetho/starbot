import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { config } from "./config.js";

/** Shared LLM auth and registry singletons */
export const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey(config.LLM_PROVIDER, config.LLM_API_KEY);

if (config.CHEAP_LLM_PROVIDER && config.CHEAP_LLM_MODEL) {
  authStorage.setRuntimeApiKey(config.CHEAP_LLM_PROVIDER, config.LLM_API_KEY);
}

export const modelRegistry = ModelRegistry.create(authStorage);

export const mainModel = modelRegistry.find(config.LLM_PROVIDER, config.LLM_MODEL);

export const memoryModel = config.CHEAP_LLM_PROVIDER && config.CHEAP_LLM_MODEL
  ? modelRegistry.find(config.CHEAP_LLM_PROVIDER, config.CHEAP_LLM_MODEL) ?? mainModel
  : mainModel;

if (!mainModel) {
  console.warn(
    `[providers] Model ${config.LLM_PROVIDER}/${config.LLM_MODEL} not found; pi will pick first available.`
  );
}

if (config.CHEAP_LLM_PROVIDER && config.CHEAP_LLM_MODEL && !memoryModel) {
  console.warn(
    `[providers] Cheap model ${config.CHEAP_LLM_PROVIDER}/${config.CHEAP_LLM_MODEL} not found; falling back to main model.`
  );
}