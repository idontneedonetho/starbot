import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Keyv from 'keyv';
import KeyvSqlite from '@keyv/sqlite';
import { createLogger } from './logger.js';

const log = createLogger('store');

const storePath = process.env.STORE_PATH || 'data/store.sqlite';
mkdirSync(dirname(storePath), { recursive: true });
const root = new KeyvSqlite({ uri: `sqlite://${storePath}`, driver: 'better-sqlite3' });

export interface StoreOptions {
  ttl?: number;
}

export function createStore<T>(namespace: string, options: StoreOptions = {}): Keyv<T> {
  const store = new Keyv<T>({ store: root, namespace, ttl: options.ttl });
  store.on('error', err => log.error({ err }, `Keyv store error in namespace "${namespace}"`));
  return store;
}
