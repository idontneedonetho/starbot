import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, embedBatchMock } = vi.hoisted(() => ({
  mockConfig: {
    openaiEndpoint: 'https://llm.example/v1',
    openaiApiKey: 'test-key',
    openaiModel: 'test-model',
  } as Record<string, string | undefined>,
  embedBatchMock: vi.fn(async (texts: string[]) => texts.map(() => [1, 1, 1])),
}));

vi.mock('../../config.js', () => ({ loadConfig: () => mockConfig }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));
vi.mock('../../wiki/embedder.js', () => ({ embedBatch: embedBatchMock }));

import { titleGenerator } from './title-generator.js';

function llmResponse(title: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title }) } }] }),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  mockConfig.openaiEndpoint = 'https://llm.example/v1';
  mockConfig.openaiApiKey = 'test-key';
  mockConfig.openaiModel = 'test-model';
  fetchMock.mockReset();
  embedBatchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TitleGenerator.generate', () => {
  it('returns the LLM title without touching the heuristic on success', async () => {
    fetchMock.mockResolvedValueOnce(llmResponse('Aggressive accel behind lead'));

    const title = await titleGenerator.generate('Bug Report', '[Observed]\nfoo', 'foo bar');

    expect(title).toBe('Aggressive accel behind lead');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embedBatchMock).not.toHaveBeenCalled();
  });

  it('retries the LLM once and returns the second attempt on first failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(llmResponse('Recovered title'));

    const title = await titleGenerator.generate('Feedback', 'content', 'content');

    expect(title).toBe('Recovered title');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(embedBatchMock).not.toHaveBeenCalled();
  });

  it('falls back to the heuristic after both LLM attempts fail', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom again'));

    const fallback =
      'the car accelerates aggressively behind a slower lead vehicle on surface streets every time';
    const title = await titleGenerator.generate('Bug Report', 'llm content', fallback);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(embedBatchMock).toHaveBeenCalled();
    expect(title).toBeTruthy();
  });

  it('skips the LLM entirely when config is incomplete', async () => {
    mockConfig.openaiApiKey = undefined;

    const title = await titleGenerator.generate('Feedback', 'llm content', 'short fallback text');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(title).toBe('Short Fallback Text');
  });

  it('sends the category to the model', async () => {
    fetchMock.mockResolvedValueOnce(llmResponse('Some title'));

    await titleGenerator.generate('Feature Request', '[Observed]\nfoo', 'foo');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemMessage = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).toContain('Feature Request');
  });
});
