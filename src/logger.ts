import pino from 'pino';
import { DiscordAPIError } from 'discord.js';

const isProduction = process.env.NODE_ENV === 'production';

export const root = pino(
  isProduction
    ? { level: process.env.LOG_LEVEL || 'info' }
    : {
        level: process.env.LOG_LEVEL || 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      },
);

export interface ModuleLogger extends pino.Logger {
  handleError: (e: unknown, msg?: string) => void;
}

export function createLogger(module: string): ModuleLogger {
  const child = root.child({ module }) as ModuleLogger;
  child.handleError = (e: unknown, msg?: string) => {
    if (e instanceof DiscordAPIError && e.code === 10062) {
      child.error({ err: e }, msg ?? 'Received unknown interaction, possible race condition');
      return;
    }
    child.error(
      { err: e instanceof Error ? e : new Error(String(e)) },
      msg ?? 'Unknown error',
    );
  };
  return child;
}
