import dotenv from 'dotenv';
dotenv.config();

export interface BotConfig {
  token: string;
  guildId: string;
  identificationChannelId: string;
  reportButtonChannelId: string;
  forumChannelId: string;
  routesChannelId: string;
  verifiedRole: string;
  pendingRole: string;
  staffRole: string;
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

  const reportButtonChannelId = process.env.REPORT_BUTTON_CHANNEL_ID;
  if (!reportButtonChannelId) throw new Error('REPORT_BUTTON_CHANNEL_ID is required');

  const forumChannelId = process.env.FORUM_CHANNEL_ID;
  if (!forumChannelId) throw new Error('FORUM_CHANNEL_ID is required');

  const routesChannelId = process.env.ROUTES_CHANNEL_ID;
  if (!routesChannelId) throw new Error('ROUTES_CHANNEL_ID is required');

  const verifiedRole = process.env.VERIFIED_ROLE;
  if (!verifiedRole) throw new Error('VERIFIED_ROLE is required');

  const pendingRole = process.env.PENDING_ROLE;
  if (!pendingRole) throw new Error('PENDING_ROLE is required');

  const staffRole = process.env.STAFF_ROLE;
  if (!staffRole) throw new Error('STAFF_ROLE is required');

  const wikiRepo = process.env.WIKI_REPO || 'StarPilot-Docs/docs';
  const wikiCacheDir = process.env.WIKI_CACHE_DIR || 'data/wiki';

  return {
    token,
    guildId,
    identificationChannelId,
    reportButtonChannelId,
    forumChannelId,
    routesChannelId,
    verifiedRole,
    pendingRole,
    staffRole,
    wikiRepo,
    wikiCacheDir,
  };
}
