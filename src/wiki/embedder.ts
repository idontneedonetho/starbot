import { pipeline } from '@huggingface/transformers';

let pipe: any = null;

async function getPipe(): Promise<any> {
  if (!pipe) {
    pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
  }
  return pipe;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const fn = await getPipe();
  const result = await fn(texts, { pooling: 'cls', normalize: true });
  const dim = result.dims![result.dims!.length - 1];
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(result.data.subarray(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

export async function getTokenizer(): Promise<any> {
  const p = await getPipe();
  return p.tokenizer;
}
