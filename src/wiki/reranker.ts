import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';
import { type WikiPage } from './types.js';

let model: any = null;
let tokenizer: any = null;

async function getReranker() {
  if (!model) {
    model = await AutoModelForSequenceClassification.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2');
    tokenizer = await AutoTokenizer.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2');
  }
  return { model, tokenizer };
}

export async function rerank(
  query: string,
  pages: WikiPage[],
  topK: number = 3,
): Promise<WikiPage[]> {
  if (pages.length === 0) return [];

  const { model, tokenizer } = await getReranker();
  const queries = pages.map(() => query);
  const docs = pages.map(p => p.content);

  const features = tokenizer(queries, {
    text_pair: docs,
    padding: true,
    truncation: true,
  });

  const output = await model(features);
  const logits: Float32Array = output.logits?.data ?? output.data ?? output;

  const scored = pages.map((page, i) => ({
    page,
    score: logits[i * 2],
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.page);
}
