import dotenv from 'dotenv';
dotenv.config();

export interface BotConfig {
  token: string;
  guildId: string;
  identificationChannelId: string;
  forumChannelId: string;
  routesChannelId: string;
  verifiedRole: string;
  pendingRole: string;
  wikiRepo: string;
  wikiCacheDir: string;
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

  const verifiedRole = process.env.VERIFIED_ROLE;
  if (!verifiedRole) throw new Error('VERIFIED_ROLE is required');

  const pendingRole = process.env.PENDING_ROLE;
  if (!pendingRole) throw new Error('PENDING_ROLE is required');

  const wikiRepo = process.env.WIKI_REPO || 'StarPilot-Docs/docs';
  const wikiCacheDir = process.env.WIKI_CACHE_DIR || 'data/wiki';

  return {
    token,
    guildId,
    identificationChannelId,
    forumChannelId,
    routesChannelId,
    verifiedRole,
    pendingRole,
    wikiRepo,
    wikiCacheDir,
  };
}
