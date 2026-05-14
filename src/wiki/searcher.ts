import { type WikiResult } from './types.js';
import { type WikiIndex } from './indexer.js';
import { embed } from './embedder.js';
import { rerank } from './reranker.js';

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const RRF_K = 60;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function searchWiki(
  index: WikiIndex,
  query: string,
  topK: number = 3,
): Promise<WikiResult[]> {
  const queryEmbedding = await embed(QUERY_PREFIX + query);

  // BM25 lexical search — top 10
  const bm25Results = index.search(query).slice(0, 10);
  const bm25Rank = new Map(bm25Results.map((r, i) => [r.id, i + 1]));

  // Dense cosine search — top 10
  const pages = [...index.pages.values()];
  const cosPairs: Array<{ id: string; cos: number }> = [];
  for (const p of pages) {
    const emb = index.getContentEmbedding(p.path);
    if (emb) cosPairs.push({ id: p.path, cos: cosine(queryEmbedding, emb) });
  }
  cosPairs.sort((a, b) => b.cos - a.cos);
  const cosTop10 = cosPairs.slice(0, 10);
  const cosRank = new Map(cosTop10.map((r, i) => [r.id, i + 1]));

  // RRF: merge into top 10 unique
  const rrfScores = new Map<string, number>();
  const addRank = (id: string, rank: number) => {
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank));
  };
  for (const [id, rank] of bm25Rank) addRank(id, rank);
  for (const [id, rank] of cosRank) addRank(id, rank);

  const rrfTop = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);

  // Stage 2: cross-encoder rerank
  const candidates = rrfTop.map(id => index.getPage(id)).filter(Boolean) as NonNullable<ReturnType<WikiIndex['getPage']>>[];

  const reranked = await rerank(query, candidates, topK);

  return reranked.map(p => ({
    title: p.title,
    url: p.url,
    score: 1,
  }));
}

export function formatWikiResults(results: WikiResult[]): string {
  return results.map((r, i) => `${i + 1}. ${r.title} — <${r.url}>`).join('\n');
}

export async function autoSearchWiki(
  index: WikiIndex,
  query: string,
  topK: number = 3,
): Promise<string | null> {
  const results = await searchWiki(index, query, topK);
  if (results.length === 0) return null;
  return `📖 **Potential matches:**\n${formatWikiResults(results)}`;
}
