import { Client, SlashCommandBuilder, REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";
import { PLUGINS_DIR } from "../config.js";

const commands = new Map<string, { data: SlashCommandBuilder; execute: (interaction: any) => Promise<void> }>();
const eventHandlers = new Map<string, Array<(client: Client, ...args: any[]) => Promise<void>>>();
let restRef: REST | null = null;
let applicationId: string | null = null;

interface Plugin {
  command?: {
    data: SlashCommandBuilder;
    execute: (interaction: any) => Promise<void>;
  };
  events?: Record<string, (client: Client, ...args: any[]) => Promise<void>>;
}

export function initPluginSystem(client: Client, rest: REST, appId: string): void {
  restRef = rest;
  applicationId = appId;
  loadAllPlugins();
}

export async function loadPlugin(pluginPath: string): Promise<void> {
  const resolvedPath = require.resolve(pluginPath);
  if (require.cache[resolvedPath]) {
    delete require.cache[resolvedPath];
  }

  const plugin: Plugin = require(resolvedPath);
  const name = path.basename(pluginPath, ".js").replace(/^plugin-/, "");

  if (plugin.command) {
    commands.set(name, {
      data: plugin.command.data,
      execute: plugin.command.execute,
    });
    console.log(`[plugins] Loaded command: ${name}`);
  }

  if (plugin.events) {
    for (const [eventName, handler] of Object.entries(plugin.events)) {
      const handlers = eventHandlers.get(eventName) || [];
      handlers.push(handler);
      eventHandlers.set(eventName, handlers);
      console.log(`[plugins] Loaded event handler: ${eventName} -> ${name}`);
    }
  }
}

export async function registerCommand(name: string): Promise<void> {
  const cmd = commands.get(name);
  if (!cmd) throw new Error(`Command ${name} not found in loaded plugins`);

  if (!restRef || !applicationId) {
    console.warn(`[plugins] REST not initialized, skipping Discord registration for ${name}`);
    return;
  }

  try {
    const cmdData = cmd.data.toJSON();
    await restRef.put(
      Routes.applicationCommands(applicationId),
      { body: [cmdData] }
    );
    console.log(`[plugins] Registered command globally: ${name}`);
  } catch (err) {
    console.error(`[plugins] Failed to register command ${name}:`, err);
    throw err;
  }
}

export function unloadPlugin(name: string): void {
  if (commands.has(name)) {
    commands.delete(name);
    console.log(`[plugins] Unloaded command: ${name}`);
  }
  if (eventHandlers.has(name)) {
    eventHandlers.delete(name);
    console.log(`[plugins] Unloaded event handlers: ${name}`);
  }
}

export function getCommand(name: string): { data: SlashCommandBuilder; execute: (interaction: any) => Promise<void> } | undefined {
  return commands.get(name);
}

export function getEventHandlers(eventName: string): Array<(client: Client, ...args: any[]) => Promise<void>> {
  return eventHandlers.get(eventName) || [];
}

export async function loadAllPlugins(): Promise<void> {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    console.log(`[plugins] Created plugins directory: ${PLUGINS_DIR}`);
    return;
  }

  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js"));
  console.log(`[plugins] Found ${files.length} plugin(s) to load`);

  for (const file of files) {
    try {
      await loadPlugin(path.join(PLUGINS_DIR, file));
    } catch (err) {
      console.warn(`[plugins] Failed to load ${file}:`, err);
    }
  }
}