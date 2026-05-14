import { type WikiIndex } from './indexer.js';

let index: WikiIndex | null = null;

export function setIndex(idx: WikiIndex): void {
  index = idx;
}

export function getIndex(): WikiIndex | null {
  return index;
}
