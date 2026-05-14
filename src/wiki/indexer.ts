import fs from 'fs';
import path from 'path';
import MiniSearch from 'minisearch';
import { type WikiPage } from './types.js';
import { embed, embedBatch } from './embedder.js';

interface CachedPage {
  path: string;
  mtime: number;
  titleEmbedding: number[];
  contentEmbedding: number[];
}

interface CacheData {
  version: number;
  pages: CachedPage[];
}

const CACHE_VERSION = 4;

function cachePath(base: string): string {
  return path.join(base, '..', 'data', 'wiki-embeddings.json');
}

export interface WikiIndex {
  search: (query: string) => Array<{ id: string; score: number }>;
  getPage: (id: string) => WikiPage | undefined;
  getTitleEmbedding: (id: string) => number[] | undefined;
  getContentEmbedding: (id: string) => number[] | undefined;
  pages: Map<string, WikiPage>;
}

export async function buildIndex(wikiPages: WikiPage[], wikiClonePath: string): Promise<WikiIndex> {
  const pageMap = new Map<string, WikiPage>();
  const miniSearch = new MiniSearch({
    fields: ['title', 'content'],
    storeFields: ['title'],
    idField: 'path',
  });
  const docs = wikiPages.map(p => ({ path: p.path, title: p.title, content: p.content }));
  miniSearch.addAll(docs);
  for (const p of wikiPages) pageMap.set(p.path, p);

  // Check cache
  const cache = loadCache(wikiClonePath);
  const stalePages: WikiPage[] = [];
  const cachedMap = new Map<string, CachedPage>();

  if (cache) {
    for (const c of cache.pages) cachedMap.set(c.path, c);
  }

  for (const p of wikiPages) {
    const cached = cachedMap.get(p.path);
    const mtime = getMtime(wikiClonePath, p.path);
    if (!cached || cached.mtime !== mtime) {
      stalePages.push(p);
    }
  }

  if (stalePages.length > 0) {
    // Pre-compute both title and full-content embeddings for stale pages
    const titleTexts = stalePages.map(p => p.title);
    const contentTexts = stalePages.map(p => p.content);

    const [titleEmbeddings, contentEmbeddings] = await Promise.all([
      embedBatch(titleTexts),
      embedBatch(contentTexts),
    ]);

    for (let i = 0; i < stalePages.length; i++) {
      const p = stalePages[i];
      const mtime = getMtime(wikiClonePath, p.path);
      cachedMap.set(p.path, {
        path: p.path,
        mtime,
        titleEmbedding: titleEmbeddings[i],
        contentEmbedding: contentEmbeddings[i],
      });
    }

    // Save updated cache
    saveCache(wikiClonePath, cachedMap);
  }

  const titleEmbedMap = new Map<string, number[]>();
  const contentEmbedMap = new Map<string, number[]>();

  for (const [id, cached] of cachedMap) {
    titleEmbedMap.set(id, cached.titleEmbedding);
    contentEmbedMap.set(id, cached.contentEmbedding);
  }

  return {
    search(query: string) {
      return miniSearch.search(query, { prefix: true, fuzzy: 0.2, boost: { title: 2 } });
    },
    getPage(id: string) { return pageMap.get(id); },
    getTitleEmbedding(id: string) { return titleEmbedMap.get(id); },
    getContentEmbedding(id: string) { return contentEmbedMap.get(id); },
    pages: pageMap,
  };
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
    // no cache
  }
  return null;
}

function saveCache(wikiClonePath: string, cachedMap: Map<string, CachedPage>): void {
  const cp = cachePath(wikiClonePath);
  const dir = path.dirname(cp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data: CacheData = {
    version: CACHE_VERSION,
    pages: [...cachedMap.values()],
  };
  fs.writeFileSync(cp, JSON.stringify(data), 'utf-8');
}
