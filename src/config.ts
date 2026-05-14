import dotenv from 'dotenv';
dotenv.config();

export interface BotConfig {
  token: string;
  guildId: string;
  identificationChannelId: string;
  forumChannelId: string;
  routesChannelId: string;
  ignoredRoles: string[];
  wikiCloneUrl: string;
  wikiClonePath: string;
}

export function loadConfig(): BotConfig {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is required');

  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error('GUILD_ID is required');

  const identificationChannelId = process.env.IDENTIFICATION_CHANNEL_ID;
  if (!identificationChannelId) throw new Error('IDENTIFICATION_CHANNEL_ID is required');

  const forumChannelId = process.env.FORUM_CHANNEL_ID;
  if (!forumChannelId) throw new Error('FORUM_CHANNEL_ID is required');

  const routesChannelId = process.env.ROUTES_CHANNEL_ID;
  if (!routesChannelId) throw new Error('ROUTES_CHANNEL_ID is required');

  const ignoredRoles = (process.env.IGNORED_ROLES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const wikiCloneUrl = process.env.WIKI_CLONE_URL || 'https://github.com/StarPilot-Docs/docs.git';
  const wikiClonePath = process.env.WIKI_CLONE_PATH || 'data/docs';

  return {
    token,
    guildId,
    identificationChannelId,
    forumChannelId,
    routesChannelId,
    ignoredRoles,
    wikiCloneUrl,
    wikiClonePath,
  };
}
