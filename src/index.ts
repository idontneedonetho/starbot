import { Client } from 'discordx';
import { IntentsBitField } from 'discord.js';
import { loadConfig } from './config.js';
import { root as log } from './logger.js';
import './handlers/events.js';
import './handlers/clip/index.js';
import './handlers/identification/index.js';
import './handlers/report/index.js';
import './handlers/report/report-actions.js';
import './handlers/share-route.js';

const config = loadConfig();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
  silent: true,
  // Reject (throw) only on rate-limited thread/channel *edits* (PATCH /channels/:id)
  // so title-sync can defer + retry them instead of blocking the strict channel-edit
  // bucket. Message sends, thread creation, etc. queue and wait as normal.
  rest: { rejectOnRateLimit: (data) => data.method === 'PATCH' && data.route === '/channels/:id' },
});

client.login(config.token);

function shutdown() {
  log.info('Shutting down...');
  client.destroy();
  process.exit(0);
}

process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'Unhandled rejection');
  shutdown();
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  shutdown();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
