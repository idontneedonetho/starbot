import { type WikiChunk } from './types.js';

export interface ScoredWikiChunk {
  chunk: WikiChunk;
  score: number;
}

export function rerank(
  chunks: WikiChunk[],
  bm25Rank: Map<string, number>,
  cosineRank: Map<string, number>,
  opts: {
    k: number;
    p: number;
    wBm25: number;
    wCos: number;
    cutoffRank: number;
    topK?: number;
  },
): ScoredWikiChunk[] {
  if (chunks.length === 0) return [];

  const { k, p, wBm25, wCos, cutoffRank, topK } = opts;

  const scored: ScoredWikiChunk[] = chunks.map(chunk => {
    const bm25 = bm25Rank.get(chunk.path);
    const cos = cosineRank.get(chunk.path);

    const bm25Contrib = bm25 == null || bm25 > cutoffRank ? 0 : wBm25 / Math.pow(k + bm25, p);
    const cosContrib = cos == null || cos > cutoffRank ? 0 : wCos / Math.pow(k + cos, p);

    return {
      chunk,
      score: bm25Contrib + cosContrib,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return typeof topK === 'number' ? scored.slice(0, topK) : scored;
}
