import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  fetchBergetModels,
  mapBergetModelToModel,
  MODEL_OVERRIDES,
  resolveInputUrl,
} from '../index';

// Minimal BergetModel used by the table-driven override test. Per-field
// values are arbitrary but valid; each test asserts only the override fields.
function minimalModel(id: string) {
  return {
    contextWindow: 128_000,
    id,
    inputPricePerToken: 0.000_000_3,
    outputPricePerToken: 0.000_000_3,
  };
}

describe('Model Fetching & Mapping', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  });

  test('mapBergetModelToModel maps API response to Model', () => {
    const apiModel = {
      contextWindow: 128_000,
      id: 'meta-llama/Llama-3.3-70B-Instruct',
      inputPricePerToken: 0.000_000_3,
      outputPricePerToken: 0.000_001_5,
    };

    const result = mapBergetModelToModel(apiModel);

    expect(result.id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(result.name).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(result.api).toBe('openai-completions');
    expect(result.provider).toBe('berget');
    // mapBergetModelToModel uses getInferenceUrl(), which defaults to the
    // Berget inference endpoint when BERGET_INFERENCE_URL is unset.
    expect(result.baseUrl).toBe('https://api.berget.ai/v1');
    expect(result.reasoning).toBe(false);
    expect(result.input).toEqual(['text']);
    expect(result.cost).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 0.3,
      output: 1.5,
    });
    expect(result.contextWindow).toBe(128_000);
    expect(result.maxTokens).toBe(32_768);
    expect(result.compat).toEqual({ supportsDeveloperRole: false });
  });

  test('fetchBergetModels returns mapped models from API', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = resolveInputUrl(input);
      if (url.includes('/v1/models/chat')) {
        return Promise.resolve(
          Response.json(
            {
              models: [
                {
                  contextWindow: 128_000,
                  id: 'meta-llama/Llama-3.3-70B-Instruct',
                  inputPricePerToken: 0.000_000_3,
                  outputPricePerToken: 0.000_001_5,
                },
                {
                  contextWindow: 128_000,
                  id: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
                  inputPricePerToken: 0.000_000_1,
                  outputPricePerToken: 0.000_000_3,
                },
              ],
            },
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('Not found', { status: 404 }));
    };

    const models = await fetchBergetModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(models[0].cost.input).toBeCloseTo(0.3);
    expect(models[0].cost.output).toBeCloseTo(1.5);
    expect(models[0].compat).toEqual({ supportsDeveloperRole: false });
    expect(models[1].id).toBe('mistralai/Mistral-Small-3.2-24B-Instruct-2506');
    expect(models[1].input).toEqual(['text', 'image']);
    expect(models[1].cost.input).toBeCloseTo(0.1);
    expect(models[1].cost.output).toBeCloseTo(0.3);
  });

  test('fetchBergetModels returns empty array for empty models response', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> => {
      return Promise.resolve(
        Response.json(
          { models: [] },
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      );
    };

    const models = await fetchBergetModels();
    expect(models).toEqual([]);
  });

  test('fetchBergetModels throws on API failure', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> => {
      return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
    };

    await expect(fetchBergetModels()).rejects.toThrow('Failed to fetch models: 500');
  });

  test('mapBergetModelToModel uses DEFAULT_MAX_TOKENS when not provided by API', () => {
    const apiModel = {
      contextWindow: 32_000,
      id: 'test-model',
      inputPricePerToken: 0,
      outputPricePerToken: 0,
    };

    const result = mapBergetModelToModel(apiModel);
    expect(result.maxTokens).toBe(32_768);
  });

  test('mapBergetModelToModel calculates per-million-token costs correctly', () => {
    const apiModel = {
      contextWindow: 128_000,
      id: 'price-test',
      inputPricePerToken: 0.000_000_5,
      outputPricePerToken: 0.000_002,
    };

    const result = mapBergetModelToModel(apiModel);
    expect(result.cost.input).toBe(0.5);
    expect(result.cost.output).toBe(2);
  });

  // --- Override tests ---

  test('mapBergetModelToModel applies vision override for known vision models', () => {
    const apiModel = {
      contextWindow: 262_144,
      id: 'google/gemma-4-31B-it',
      inputPricePerToken: 0.000_000_25,
      outputPricePerToken: 0.000_000_5,
    };

    const result = mapBergetModelToModel(apiModel);
    expect(result.input).toEqual(['text', 'image']);
  });

  test('mapBergetModelToModel applies reasoning override for known reasoning models', () => {
    const apiModel = {
      contextWindow: 128_000,
      id: 'openai/gpt-oss-120b',
      inputPricePerToken: 0.000_000_2,
      outputPricePerToken: 0.000_000_75,
    };

    const result = mapBergetModelToModel(apiModel);
    expect(result.reasoning).toBe(true);
    expect(result.input).toEqual(['text']);
  });

  test('mapBergetModelToModel defaults unknown models to text-only without reasoning', () => {
    const apiModel = {
      contextWindow: 64_000,
      id: 'future-model-v99',
      inputPricePerToken: 0,
      outputPricePerToken: 0,
    };

    const result = mapBergetModelToModel(apiModel);
    expect(result.input).toEqual(['text']);
    expect(result.reasoning).toBe(false);
  });

  test('mapBergetModelToModel preserves cost and contextWindow when applying override', () => {
    const apiModel = {
      contextWindow: 262_144,
      id: 'mistralai/Mistral-Medium-3.5-128B',
      inputPricePerToken: 0.000_001_5,
      outputPricePerToken: 0.000_005,
    };

    const result = mapBergetModelToModel(apiModel);

    expect(result.input).toEqual(['text', 'image']);
    expect(result.reasoning).toBe(true);
    expect(result.contextWindow).toBe(262_144);
    expect(result.cost.input).toBe(1.5);
    expect(result.cost.output).toBe(5);
    expect(result.cost.cacheRead).toBe(0);
  });

  test('mapBergetModelToModel applies vision and reasoning override for moonshotai/Kimi-K2.6', () => {
    const apiModel = {
      contextWindow: 256_000,
      id: 'moonshotai/Kimi-K2.6',
      inputPricePerToken: 0.000_000_2,
      outputPricePerToken: 0.000_000_8,
    };

    const result = mapBergetModelToModel(apiModel);

    expect(result.input).toEqual(['text', 'image']);
    expect(result.reasoning).toBe(true);
    expect(result.contextWindow).toBe(256_000);
    expect(result.cost.input).toBeCloseTo(0.2);
    expect(result.cost.output).toBeCloseTo(0.8);
  });
});

describe('MODEL_OVERRIDES table (regression guard)', () => {
  // Every override must actually win over the base defaults. This catches:
  //   - dropped overrides (e.g. an id that no longer matches the API catalog),
  //   - bad thinkingLevelMap shapes,
  //   - the GLM-5.2 maxTokens bump.
  // It does NOT catch key/API drift — that needs a fixture against a real
  // /v1/models/chat snapshot.
  for (const [id, override] of Object.entries(MODEL_OVERRIDES)) {
    test(`override for ${id} replaces the base defaults`, () => {
      const result = mapBergetModelToModel(minimalModel(id));
      expect(result.id).toBe(id);

      for (const [key, value] of Object.entries(override)) {
        expect(result[key as keyof typeof result]).toEqual(value);
      }

      // Untouched base fields must survive the spread (shallow merge: the
      // override replaces whole sub-objects, so verify the ones overrides
      // never touch).
      expect(result.compat).toEqual({ supportsDeveloperRole: false });
      expect(result.cost.cacheRead).toBe(0);
      expect(result.cost.cacheWrite).toBe(0);
      expect(result.contextWindow).toBe(128_000);
      expect(result.maxTokens).toBe(override.maxTokens ?? 32_768);
    });
  }

  test('every override key is a non-empty string (guard against typos/blank ids)', () => {
    for (const id of Object.keys(MODEL_OVERRIDES)) {
      expect(id, 'override id must be non-empty').toMatch(/^.+$/);
    }
  });
});
