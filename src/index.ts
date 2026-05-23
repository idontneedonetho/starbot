import { Client } from 'discordx';
import { IntentsBitField } from 'discord.js';
import { loadConfig } from './config.js';
import './handlers/events.js';
import './handlers/buttons.js';
import './handlers/modals.js';
import './handlers/clip-commands.js';

const config = loadConfig();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
  silent: false,
});

client.login(config.token);

function shutdown() {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  shutdown();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
