import { type WikiResult, type WikiPage } from './types.js';
import { type WikiIndex } from './indexer.js';
import { embedBatch } from './embedder.js';
import { rerank } from './reranker.js';

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const RRF_K = 20;
const BM25_TOP_K = 500;
const COSINE_TOP = 100;
const FUSION_TOP_CUTOFF_RANK = 100;
const FUSION_P = 1.6;
const FUSION_W_BM25 = 1.0;
const FUSION_W_COS = 1.2;

function dot(a: number[], b: number[]): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result += a[i] * b[i];
  }
  return result;
}

export async function searchWiki(
  index: WikiIndex,
  query: string,
  topK: number = 3,
): Promise<WikiResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // BM25 over the full query.
  const bm25Results = index.search(trimmed).slice(0, BM25_TOP_K);
  if (bm25Results.length === 0) return [];

  const bm25Rank = new Map<string, number>();
  for (let i = 0; i < bm25Results.length; i++) {
    bm25Rank.set(bm25Results[i].id, i + 1);
  }

  // Dense cosine: embed the query once, then score BM25 candidates.
  const [queryEmbedding] = await embedBatch([QUERY_PREFIX + trimmed]);

  const cosinePairs: Array<{ id: string; cos: number }> = [];
  for (const { id } of bm25Results) {
    const candidateEmb = index.getContentEmbedding(id);
    if (!candidateEmb) continue;
    cosinePairs.push({ id, cos: dot(queryEmbedding, candidateEmb) });
  }

  cosinePairs.sort((a, b) => b.cos - a.cos);
  const cosRank = new Map<string, number>(cosinePairs.slice(0, COSINE_TOP).map((r, i) => [r.id, i + 1]));

  // Candidate chunks to fuse.
  const candidates = bm25Results
    .map(({ id }) => index.getChunk(id))
    .filter((c): c is NonNullable<typeof c> => c != null);

  const scoredChunks = await rerank('', candidates, bm25Rank, cosRank, {
    k: RRF_K,
    p: FUSION_P,
    wBm25: FUSION_W_BM25,
    wCos: FUSION_W_COS,
    cutoffRank: FUSION_TOP_CUTOFF_RANK,
    topK: candidates.length,
  });

  // Map chunk scores → parent page scores (max + 0.2 * mean over chunks).
  const parentScores = new Map<string, { max: number; sum: number; count: number; page: WikiPage }>();
  for (const { chunk, score } of scoredChunks) {
    const page = index.getParentPageFromChunk(chunk.path);
    if (!page) continue;

    const key = page.path;
    const prev = parentScores.get(key) ?? { max: -Infinity, sum: 0, count: 0, page };
    parentScores.set(key, {
      max: Math.max(prev.max, score),
      sum: prev.sum + score,
      count: prev.count + 1,
      page,
    });
  }

  const bestByParent = new Map<string, { result: WikiResult; score: number }>();
  for (const [key, { max, sum, count, page }] of parentScores) {
    // max + 0.2 * mean rewards pages with broader coverage
    const parentScore = max + 0.2 * (sum / count);
    bestByParent.set(key, {
      score: parentScore,
      result: {
        title: page.title,
        url: page.url,
        score: parentScore,
      },
    });
  }

  return [...bestByParent.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(v => v.result);
}

export function formatWikiResults(results: WikiResult[]): string {
  return results.map((r, i) => `${i + 1}. ${r.title} — <${r.url}>`).join('\n');
}

export async function autoSearchWiki(
  index: WikiIndex,
  query: string,
  topK: number = 3,
): Promise<WikiResult[]> {
  const results = await searchWiki(index, query, topK);
  return results;
}
