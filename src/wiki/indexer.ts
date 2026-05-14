import fs from 'fs';
import path from 'path';
import MiniSearch from 'minisearch';
import { type WikiChunk, type WikiPage } from './types.js';
import { embedBatch } from './embedder.js';
import { chunkTextByTokens } from './chunker.js';

const INDEX_CHUNK_TOKENS = 512;
const INDEX_CHUNK_OVERLAP = 64;

const CACHE_VERSION = 6;

function cachePath(base: string): string {
  return path.join(base, '..', 'data', 'wiki-embeddings.json');
}

interface CachedChunk {
  path: string;
  mtime: number;
  contentEmbedding: number[];
}

interface CacheData {
  version: number;
  chunks: CachedChunk[];
}

function getMtime(wikiClonePath: string, filePath: string): number {
  try {
    return fs.statSync(path.join(wikiClonePath, filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

function loadCache(wikiClonePath: string): CacheData | null {
  const cp = cachePath(wikiClonePath);
  try {
    const raw = fs.readFileSync(cp, 'utf-8');
    const data = JSON.parse(raw) as CacheData;
    if (data.version === CACHE_VERSION) return data;
  } catch {
    // ignore
  }
  return null;
}

function saveCache(wikiClonePath: string, cachedMap: Map<string, CachedChunk>): void {
  const cp = cachePath(wikiClonePath);
  const dir = path.dirname(cp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const data: CacheData = {
    version: CACHE_VERSION,
    chunks: [...cachedMap.values()],
  };

  fs.writeFileSync(cp, JSON.stringify(data), 'utf-8');
}

export interface WikiIndex {
  search: (query: string) => Array<{ id: string; score: number }>;
  getChunk: (id: string) => WikiChunk | undefined;
  getContentEmbedding: (id: string) => number[] | undefined;
  getParentPageFromChunk: (chunkId: string) => WikiPage | undefined;
  chunks: Map<string, WikiChunk>;
}

export async function buildIndex(wikiPages: WikiPage[], wikiClonePath: string): Promise<WikiIndex> {
  // Map parent-page path -> page metadata.
  const parentPageMap = new Map<string, WikiPage>();
  for (const p of wikiPages) parentPageMap.set(p.path, p);

  const miniSearch = new MiniSearch({
    fields: ['title', 'content'],
    storeFields: ['title', 'parentPath'],
    idField: 'path',
  });

  const chunkMap = new Map<string, WikiChunk>();
  const docs: Array<{ path: string; title: string; content: string; parentPath: string }> = [];

  // Chunk every page for passage-level retrieval.
  const pageMtimes = new Map<string, number>();
  for (const p of wikiPages) pageMtimes.set(p.path, getMtime(wikiClonePath, p.path));

  for (const p of wikiPages) {
    const contentChunks = await chunkTextByTokens(p.content, INDEX_CHUNK_TOKENS, INDEX_CHUNK_OVERLAP);

    for (let i = 0; i < contentChunks.length; i++) {
      const chunkId = `${p.path}#${i}`;
      const content = contentChunks[i];

      chunkMap.set(chunkId, {
        path: chunkId,
        parentPath: p.path,
        title: p.title,
        content,
        url: p.url,
      });

      docs.push({ path: chunkId, title: p.title, content, parentPath: p.path });
    }
  }

  miniSearch.addAll(docs);

  // Cache passage embeddings (invalidated on parent-page mtime).
  const cache = loadCache(wikiClonePath);
  const cachedMap = new Map<string, CachedChunk>();
  if (cache) for (const c of cache.chunks) cachedMap.set(c.path, c);

  const staleChunks: WikiChunk[] = [];
  for (const chunk of chunkMap.values()) {
    const mtime = pageMtimes.get(chunk.parentPath) ?? 0;
    const cached = cachedMap.get(chunk.path);
    if (!cached || cached.mtime !== mtime) staleChunks.push(chunk);
  }

  if (staleChunks.length > 0) {
    const contentTexts = staleChunks.map(c => `${c.title}\n\n${c.content}`);
    const contentEmbeddings = await embedBatch(contentTexts);

    for (let i = 0; i < staleChunks.length; i++) {
      const c = staleChunks[i];
      const mtime = pageMtimes.get(c.parentPath) ?? 0;

      cachedMap.set(c.path, {
        path: c.path,
        mtime,
        contentEmbedding: contentEmbeddings[i],
      });
    }

    saveCache(wikiClonePath, cachedMap);
  }

  const contentEmbedMap = new Map<string, number[]>();
  for (const [id, cached] of cachedMap) {
    contentEmbedMap.set(id, cached.contentEmbedding);
  }

  return {
    search(query: string) {
      return miniSearch.search(query, { prefix: true, fuzzy: 0.2, boost: { title: 2 } });
    },
    getChunk(id: string) {
      return chunkMap.get(id);
    },
    getContentEmbedding(id: string) {
      return contentEmbedMap.get(id);
    },
    getParentPageFromChunk(chunkId: string) {
      const c = chunkMap.get(chunkId);
      if (!c) return undefined;
      return parentPageMap.get(c.parentPath);
    },
    chunks: chunkMap,
  };
}
