import { Client, SlashCommandBuilder, REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { PLUGINS_DIR } from "../config.js";

export const commands = new Map<string, { data: SlashCommandBuilder; execute: (interaction: any) => Promise<void> }>();
const eventHandlers = new Map<string, Array<(client: Client, ...args: any[]) => Promise<void>>>();

// Maps plugin name → list of { eventName, handler } pairs so we can surgically
// remove only that plugin's handlers without touching other plugins' registrations.
type HandlerEntry = { eventName: string; handler: (client: Client, ...args: any[]) => Promise<void> };
const pluginEventIndex = new Map<string, HandlerEntry[]>();

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
  try {
    const fileUrl = pathToFileURL(pluginPath).href;
    const module = await import(`${fileUrl}?t=${Date.now()}`);
    const plugin: Plugin = module;
    const name = path.basename(pluginPath, ".js").replace(/^plugin-/, "");

    if (plugin.command) {
      commands.set(name, {
        data: plugin.command.data,
        execute: plugin.command.execute,
      });
      console.log(`[plugins] Loaded command: ${name}`);
    }

    if (plugin.events) {
      const entries: HandlerEntry[] = [];
      for (const [eventName, handler] of Object.entries(plugin.events)) {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
        entries.push({ eventName, handler });
        console.log(`[plugins] Loaded event handler: ${eventName} -> ${name}`);
      }
      pluginEventIndex.set(name, entries);
    }
  } catch (err) {
    throw new Error(`Failed to load plugin: ${err}`);
  }
}

export async function syncDiscordCommands(staticCommands: any[] = []): Promise<void> {
  if (!restRef || !applicationId) {
    console.warn(`[plugins] REST not initialized, skipping Discord registration`);
    return;
  }

  const allCmds = [
    ...staticCommands.map(c => c.data.toJSON()),
    ...Array.from(commands.values()).map(c => c.data.toJSON()),
  ];

  try {
    await restRef.put(
      Routes.applicationCommands(applicationId),
      { body: allCmds },
    );
    console.log(`[plugins] Synced ${allCmds.length} commands globally`);
  } catch (err) {
    console.error(`[plugins] Failed to sync commands:`, err);
    throw err;
  }
}

export function unloadPlugin(name: string): void {
  if (commands.delete(name)) {
    console.log(`[plugins] Unloaded command: ${name}`);
  }

  // Filter out only this plugin's handler functions, leaving other plugins' handlers intact.
  const entries = pluginEventIndex.get(name) ?? [];
  for (const { eventName, handler } of entries) {
    const handlers = eventHandlers.get(eventName);
    if (handlers) {
      const filtered = handlers.filter(h => h !== handler);
      if (filtered.length > 0) {
        eventHandlers.set(eventName, filtered);
      } else {
        eventHandlers.delete(eventName);
      }
    }
  }
  if (entries.length > 0) {
    pluginEventIndex.delete(name);
    console.log(`[plugins] Unloaded event handlers for: ${name}`);
  }
}

export function getCommand(name: string): { data: SlashCommandBuilder; execute: (interaction: any) => Promise<void> } | undefined {
  return commands.get(name);
}

export function getEventHandlers(eventName: string): Array<(client: Client, ...args: any[]) => Promise<void>> {
  return eventHandlers.get(eventName) ?? [];
}

export async function loadAllPlugins(): Promise<void> {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    console.log(`[plugins] Created plugins directory: ${PLUGINS_DIR}`);
    return;
  }

  let totalLoaded = 0;

  // Load root-level .js files
  const rootFiles = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js"));
  for (const file of rootFiles) {
    try {
      await loadPlugin(path.join(PLUGINS_DIR, file));
      totalLoaded++;
    } catch (err) {
      console.warn(`[plugins] Failed to load ${file}:`, err);
    }
  }

  // Load .js files from one-level-deep subdirectories
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(PLUGINS_DIR, entry.name);
    const subFiles = fs.readdirSync(subDir).filter(f => f.endsWith(".js"));
    for (const file of subFiles) {
      try {
        await loadPlugin(path.join(subDir, file));
        totalLoaded++;
      } catch (err) {
        console.warn(`[plugins] Failed to load ${entry.name}/${file}:`, err);
      }
    }
  }

  if (totalLoaded > 0) {
    console.log(`[plugins] Loaded ${totalLoaded} plugin(s)`);
  }
}