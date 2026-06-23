import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { embedBatch } from '../../wiki/embedder.js';
import { dot } from '../../util.js';

const log = createLogger('title-generator');

const LLM_TIMEOUT_MS = 10_000;
const LLM_ATTEMPTS = 2;

function isContentWord(w: string): boolean {
  if (w.length >= 4) return true;
  if (w.length >= 3 && w === w.toUpperCase() && /[A-Z]/.test(w[0])) return true;
  if (w.includes("'t")) return true;
  return false;
}

function getNGrams(words: string[], n: number): { phrase: string; start: number; len: number }[] {
  const result: { phrase: string; start: number; len: number }[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    result.push({ phrase: words.slice(i, i + n).join(' '), start: i, len: n });
  }
  return result;
}

export async function generateHeuristicTitle(input: string): Promise<string | null> {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  const allWords = trimmed.split(/[^a-zA-Z0-9']+/).filter(w => w.length > 0);
  if (allWords.length === 0) return null;

  const words = allWords.length > 50 ? allWords.slice(0, 50) : allWords;

  if (words.length <= 10) {
    return words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  }

  const ngrams2 = getNGrams(words, 2);
  const ngrams3 = getNGrams(words, 3);
  const ngrams = [...ngrams2, ...ngrams3];

  const [textEmb, ...ngramEmbs] = await embedBatch([trimmed, ...ngrams.map(g => g.phrase)]);

  const scoredNgrams = ngrams.map((g, i) => ({ ...g, score: dot(textEmb, ngramEmbs[i]) }));

  const wordScores = new Array(words.length).fill(0);
  for (const sg of scoredNgrams) {
    for (let j = 0; j < sg.len; j++) {
      const idx = sg.start + j;
      if (idx < words.length) {
        wordScores[idx] = Math.max(wordScores[idx], sg.score);
      }
    }
  }

  const seen = new Map<string, { word: string; score: number; index: number }>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!isContentWord(w)) continue;
    const lower = w.toLowerCase();
    const existing = seen.get(lower);
    if (!existing || wordScores[i] > existing.score) {
      seen.set(lower, { word: w, score: wordScores[i], index: i });
    }
  }

  const scored = [...seen.values()].sort((a, b) => b.score - a.score);

  const top10 = scored
    .slice(0, 10)
    .sort((a, b) => a.index - b.index);

  if (top10.length === 0) return null;

  return top10.map(({ word }) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

export class TitleGenerator {
  async generate(category: string, llmContent: string, fallbackSource: string): Promise<string | null> {
    const llmTitle = await this.generateWithLlm(category, llmContent);
    if (llmTitle) return llmTitle;
    const heuristicTitle = await generateHeuristicTitle(fallbackSource).catch(err => {
      log.warn({ err }, 'Heuristic title generation failed');
      return null;
    });
    log.info({ category, title: heuristicTitle }, 'Generated report title via heuristic fallback');
    return heuristicTitle;
  }

  private async generateWithLlm(category: string, content: string): Promise<string | null> {
    const { openaiEndpoint, openaiApiKey, openaiModel } = loadConfig();
    if (!openaiEndpoint || !openaiApiKey || !openaiModel) {
      log.info({ category }, 'LLM title generation disabled (no OPENAI_* config), using heuristic');
      return null;
    }

    log.info({ category, model: openaiModel }, 'Generating report title via LLM');
    for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const title = await this.callLlm(openaiEndpoint, openaiApiKey, openaiModel, category, content);
        log.info(
          { category, model: openaiModel, attempt, retried: attempt > 1, durationMs: Date.now() - startedAt, title },
          attempt === 1 ? 'LLM title generated on first attempt' : 'LLM title generated after retry',
        );
        return title;
      } catch (err) {
        log.warn(
          { err, category, attempt, durationMs: Date.now() - startedAt, willRetry: attempt < LLM_ATTEMPTS },
          'LLM title generation attempt failed',
        );
      }
    }
    log.info({ category, attempts: LLM_ATTEMPTS }, 'LLM title generation exhausted retries, falling back to heuristic');
    return null;
  }

  private async callLlm(
    endpoint: string,
    apiKey: string,
    model: string,
    category: string,
    content: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                `Generate a short, descriptive Discord forum thread title (max ~60 chars) for the given ${category}. ` +
                `The title will be displayed as "[${category}] Your Title Here" - the category prefix is added automatically, so do NOT include it in your response. ` +
                'Respond with only a JSON object in this exact format: {"title": "your title here"}. ' +
                'Do NOT wrap your response in markdown code blocks or backticks. Return only the raw JSON object.',
            },
            {
              role: 'user',
              content,
            },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from model.');

    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as { title?: unknown };

    if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
      throw new Error(`Unexpected response shape: ${raw}`);
    }

    return parsed.title.trim();
  }
}

export const titleGenerator = new TitleGenerator();
