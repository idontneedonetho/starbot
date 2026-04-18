import { Client, Events } from "discord.js";
import { getEventHandlers } from "../plugins/loader.js";

const EVENT_MAP: Record<string, string> = {
  messageCreate: Events.MessageCreate,
  messageDelete: Events.MessageDelete,
  messageUpdate: Events.MessageUpdate,
  reactionAdd: Events.MessageReactionAdd,
  reactionRemove: Events.MessageReactionRemove,
  threadCreate: Events.ThreadCreate,
  threadDelete: Events.ThreadDelete,
  threadUpdate: Events.ThreadUpdate,
  guildMemberAdd: Events.GuildMemberAdd,
  guildMemberRemove: Events.GuildMemberRemove,
  interactionCreate: Events.InteractionCreate,
};

export function setupEventHandlers(client: Client): void {
  for (const [handlerName, eventName] of Object.entries(EVENT_MAP)) {
    client.on(eventName as any, async (...args: any[]) => {
      const handlers = getEventHandlers(handlerName);
      if (handlers.length === 0) return;

      for (const handler of handlers) {
        try {
          await handler(client, ...args);
        } catch (err) {
          console.error(`[events] ${handlerName} handler error:`, err);
        }
      }
    });
  }
}