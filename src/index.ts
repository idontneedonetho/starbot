import { Client } from 'discordx';
import { IntentsBitField } from 'discord.js';
import { loadConfig } from './config.js';
import './handlers/events.js';
import './handlers/buttons.js';
import './handlers/modals.js';
import './handlers/select-menus.js';

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
  if (process.env.NODE_ENV === 'production') process.exit(1);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
