import { getTokenizer } from './embedder.js';

export async function chunkTextByTokens(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): Promise<string[]> {
  const t = text.trim();
  if (!t) return [];

  if (overlapTokens >= maxTokens) overlapTokens = Math.floor(maxTokens / 4);

  const tk = await getTokenizer();

  let inputIds: number[];
  if (typeof tk.encode === 'function') {
    try {
      inputIds = tk.encode(t, { addSpecialTokens: false });
    } catch {
      inputIds = tk.encode(t);
    }
  } else {
    const out = tk(t, { addSpecialTokens: false });
    inputIds = out.inputIds ?? [];
  }

  if (!inputIds || inputIds.length === 0) return [t];
  if (inputIds.length <= maxTokens) return [t];

  const stride = maxTokens - overlapTokens;
  const chunks: string[] = [];

  for (let start = 0; start < inputIds.length; start += stride) {
    const end = Math.min(start + maxTokens, inputIds.length);
    const ids = inputIds.slice(start, end);

    const decoded = typeof tk.decode === 'function' ? tk.decode(ids) : t;
    const cleaned = decoded?.trim();
    if (cleaned) chunks.push(cleaned);

    if (end >= inputIds.length) break;
  }

  return chunks.length ? chunks : [t];
}