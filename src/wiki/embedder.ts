import { pipeline } from '@huggingface/transformers';

type EmbedFn = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array; dims?: number[] }>;

let extractor: EmbedFn | null = null;

async function getExtractor(): Promise<EmbedFn> {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5') as unknown as EmbedFn;
  }
  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const fn = await getExtractor();
  const result = await fn(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const fn = await getExtractor();
  const result = await fn(texts, { pooling: 'mean', normalize: true });
  const dim = result.dims![result.dims!.length - 1];
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(result.data.subarray(i * dim, (i + 1) * dim)));
  }
  return vectors;
}
