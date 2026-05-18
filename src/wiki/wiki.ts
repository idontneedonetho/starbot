import { type WikiIndex } from './indexer.js';

let index: WikiIndex | null = null;
let initialized = false;
let initFailed = false;

export function setIndex(idx: WikiIndex): void {
  index = idx;
  initialized = true;
}

export function setInitFailed(): void {
  initFailed = true;
}

export function getInitStatus(): 'not_started' | 'ready' | 'failed' {
  if (initialized) return 'ready';
  if (initFailed) return 'failed';
  return 'not_started';
}

export function getIndex(): WikiIndex | null {
  return index;
}
