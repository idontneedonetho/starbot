import { type WikiChunk } from './types.js';

export interface ScoredWikiChunk {
  chunk: WikiChunk;
  score: number;
}

/**
 * Model-free (no cross-encoder) fusion of BM25 ranks + dense cosine ranks.
 *
 * For a chunk d:
 *   score(d) = wBm25/(k + rankBm25(d))^p + wCos/(k + rankCos(d))^p
 */
export async function rerank(
  _query: string,
  chunks: WikiChunk[],
  bm25Rank: Map<string, number>,
  cosineRank: Map<string, number>,
  opts?: {
    k?: number;
    p?: number;
    wBm25?: number;
    wCos?: number;
    cutoffRank?: number;
    topK?: number;
  },
): Promise<ScoredWikiChunk[]> {
  if (chunks.length === 0) return [];

  const k = opts?.k ?? 50;
  const p = opts?.p ?? 2;
  const wBm25 = opts?.wBm25 ?? 1.2;
  const wCos = opts?.wCos ?? 1.0;
  const cutoffRank = opts?.cutoffRank ?? 30;
  const topK = opts?.topK;

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
