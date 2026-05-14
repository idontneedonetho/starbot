import { type WikiResult } from './types.js';
import { type WikiIndex } from './indexer.js';
import { embedBatch } from './embedder.js';
import { rerank } from './reranker.js';
import { chunkTextByTokens } from './chunker.js';

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Fusion / reranking parameters (tuned for top-1 accuracy).
const RRF_K = 20;
const BM25_TOP_PER_CHUNK = 100;
const MAX_BM25_CANDIDATES = 2000;
const COSINE_TOP = 500;
const FUSION_TOP_CUTOFF_RANK = 100;
const FUSION_P = 1.6;
const FUSION_W_BM25 = 1.0;
const FUSION_W_COS = 1.2;

const CHUNK_TOKENS = 512;
const CHUNK_OVERLAP = 64;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

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
  const chunks = await chunkTextByTokens(query, CHUNK_TOKENS, CHUNK_OVERLAP);
  if (chunks.length === 0) return [];

  // BM25 over query chunks.
  // Track the best (lowest) rank per candidate chunk id.
  const bm25Rank = new Map<string, number>();
  const candidateChunkIds = new Set<string>();

  for (const qChunk of chunks) {
    const bm25Results = index.search(qChunk).slice(0, BM25_TOP_PER_CHUNK);
    for (let i = 0; i < bm25Results.length; i++) {
      const id = bm25Results[i].id; // chunkId
      const rank = i + 1;

      candidateChunkIds.add(id);

      const prev = bm25Rank.get(id);
      if (prev == null || rank < prev) bm25Rank.set(id, rank);
    }
  }

  if (candidateChunkIds.size === 0) return [];

  // Keep dense scoring bounded.
  const bm25Entries = [...bm25Rank.entries()].sort((a, b) => a[1] - b[1]).slice(0, MAX_BM25_CANDIDATES);
  const bm25RankLimited = new Map<string, number>(bm25Entries);
  if (bm25RankLimited.size === 0) return [];

  // Dense cosine: embed each query chunk, then for each BM25 candidate chunk take max cosine.
  const queryEmbeddings = await embedBatch(chunks.map(c => QUERY_PREFIX + c));

  const cosinePairs: Array<{ id: string; cos: number }> = [];
  for (const id of bm25Entries.map(([chunkId]) => chunkId)) {
    const candidateEmb = index.getContentEmbedding(id);
    if (!candidateEmb) continue;

    let bestCos = -Infinity;
    for (const qEmb of queryEmbeddings) {
      bestCos = Math.max(bestCos, cosine(qEmb, candidateEmb));
    }

    cosinePairs.push({ id, cos: bestCos });
  }

  cosinePairs.sort((a, b) => b.cos - a.cos);
  const cosRank = new Map<string, number>(cosinePairs.slice(0, COSINE_TOP).map((r, i) => [r.id, i + 1]));

  // Candidate chunks to fuse.
  const rankIds = new Set<string>([...bm25RankLimited.keys(), ...cosRank.keys()]);
  const candidates = [...rankIds]
    .map(id => index.getChunk(id))
    .filter((c): c is NonNullable<typeof c> => c != null);

  // Rerank chunks using improved (top-1 oriented) weighted RRF.
  const scoredChunks = await rerank('', candidates, bm25RankLimited, cosRank, {
    k: RRF_K,
    p: FUSION_P,
    wBm25: FUSION_W_BM25,
    wCos: FUSION_W_COS,
    cutoffRank: FUSION_TOP_CUTOFF_RANK,
    // Score ALL fused candidates so we can safely select the best parent.
    topK: candidates.length,
  });

  // Map chunk scores → parent page scores (max over chunks).
  const bestByParent = new Map<string, { result: WikiResult; score: number }>();
  for (const { chunk, score } of scoredChunks) {
    const parent = index.getParentPageFromChunk(chunk.path);
    if (!parent) continue;

    const key = parent.path;
    const existing = bestByParent.get(key);

    if (!existing || score > existing.score) {
      bestByParent.set(key, {
        score,
        result: {
          title: parent.title,
          url: parent.url,
          score,
        },
      });
    }
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
): Promise<string | null> {
  const results = await searchWiki(index, query, topK);
  if (results.length === 0) return null;
  return `📖 **Potential matches:**\n${formatWikiResults(results)}`;
}
