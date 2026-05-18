import { pipeline } from '@huggingface/transformers';

interface EmbeddingResult {
  dims: number[];
  data: Float32Array;
}

interface EmbeddingPipeline {
  (texts: string[], options: { pooling: string; normalize: boolean }): Promise<EmbeddingResult>;
  tokenizer: {
    encode: (text: string, opts?: { addSpecialTokens: boolean }) => number[];
    decode: (ids: number[], opts?: { skipSpecialTokens: boolean }) => string;
    (text: string, opts?: { addSpecialTokens: boolean }): { inputIds: number[]; attentionMask?: number[] };
  };
}

let pipe: EmbeddingPipeline | null = null;

async function getPipe(): Promise<EmbeddingPipeline> {
  if (!pipe) {
    pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5') as unknown as EmbeddingPipeline;
  }
  return pipe;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const fn = await getPipe();
  const result = await fn(texts, { pooling: 'cls', normalize: true });
  const dims = result.dims;
  const dim = dims[dims.length - 1];
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(result.data.subarray(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

export async function getTokenizer(): Promise<EmbeddingPipeline['tokenizer']> {
  const p = await getPipe();
  return p.tokenizer;
}
