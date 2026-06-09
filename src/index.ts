import { Client } from 'discordx';
import { IntentsBitField } from 'discord.js';
import { loadConfig } from './config.js';
import { root as log } from './logger.js';
import './handlers/events.js';
import './handlers/clip/index.js';
import './handlers/identification/index.js';
import './handlers/report/index.js';
import './handlers/report/report-actions.js';

const config = loadConfig();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
  silent: true,
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
