/**
 * Tests for the Berget System One classifier models (issue #69).
 *
 * Coverage:
 *
 * 1. `fetchBergetClassifiers()` mapping: catalog fetch + `system-one` filter,
 *    lifecycle filtering, ids, €/M pricing, context windows, and the
 *    `BERGET_INFERENCE_URL` override.
 * 2. Registration: fetched classifiers are exposed via `getAllModels()`,
 *    kept out of chat-only `getModels()`, and survive a `refreshModels`
 *    overlay cycle (createProvider merges baseline + overlay by type + id).
 * 3. Degradation: a failing or malformed classifier catalog fetch registers
 *    the provider without classifiers.
 * 4. Dispatch envelope: `provider.classify` POSTs the TypeSafe System One
 *    shape to `<baseUrl>/systemone` with Bearer auth, sending public `bool`
 *    questions as wire-level `noul`.
 * 5. Answer/usage parsing: wire `noul`/`choice`/`score` back to public answer
 *    types; token usage priced at the model's catalog cost.
 * 6. Error paths: non-2xx, missing answer, missing credential, and abort all
 *    resolve (never throw) with the matching stop reason.
 *
 * Dispatch tests inject `fetch` via `ClassifierOptions.fetch`, so no
 * globalThis mocking is needed for them. Assertions on failures check
 * `stopReason` and structure only — pi-ai's `errorMessage` strings are not
 * our contract and change across pi upgrades.
 */
import type {
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  ModelsStoreEntry,
  Provider,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { fetchBergetClassifiers, resolveInputUrl } from '../index';

interface CapturedRequest {
  init: RequestInit;
  url: string;
}

/** One usable system-one entry from the live GET /v1/models catalog. */
function systemOneEntry(overrides: {
  id: string;
  lifecycle_state?: string;
  lifecycle_status?: string;
  name?: string;
  pricing?: { input: number; output: number };
}): Record<string, unknown> {
  return {
    id: overrides.id,
    lifecycle_state: overrides.lifecycle_state ?? 'eval',
    lifecycle_status: overrides.lifecycle_status ?? 'preview',
    model_type: 'system-one',
    name: overrides.name ?? overrides.id,
    pricing: overrides.pricing ?? { input: 0.042, output: 0 },
  };
}

/** OpenAI-style GET /v1/models payload: system-one models plus decoys. */
const CATALOG_FIXTURE = {
  data: [
    // Non-classifier entries — must all be filtered out.
    { id: 'meta-llama/Llama-3.3-70B-Instruct', model_type: 'text', name: 'Llama' },
    { id: 'BAAI/bge-reranker-v2-m3', model_type: 'rerank', name: 'bge-reranker' },
    { id: 'intfloat/multilingual-e5-large', model_type: 'embedding', name: 'e5' },
    // Usable system-one models — all three must come through.
    systemOneEntry({
      id: 'Qwen/Qwen3.5-2B',
      name: 'Qwen3.5-2B',
      pricing: { input: 0.042, output: 0 },
    }),
    systemOneEntry({
      id: 'convaiinnovations/laya',
      name: 'laya',
      pricing: { input: 0.042, output: 0 },
    }),
    systemOneEntry({
      id: 'Cloudflare/clef-flash',
      name: 'clef-flash',
      pricing: { input: 0.042, output: 0 },
    }),
    // Retired lifecycle — must be dropped.
    systemOneEntry({ id: 'old/system-one-model', lifecycle_state: 'retired' }),
  ],
  object: 'list',
};

/** fetch mock answering both catalog shapes per URL, 404 otherwise. */
function installCatalogFetch(): void {
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
            ],
          },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );
    }
    if (url.includes('/v1/models')) {
      return Promise.resolve(
        Response.json(CATALOG_FIXTURE, {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
    }
    return Promise.resolve(new Response('Not found', { status: 404 }));
  };
}

/** Wire body for a successful System One call covering all three shapes. */
const SUCCESS_BODY = {
  answers: {
    refund: { noul: 0.93, type: 'noul' },
    route: {
      choice: 'billing',
      confidence: 0.85,
      probabilities: { billing: 0.8, technical: 0.2 },
      type: 'choice',
    },
    urgency: { confidence: 0.9, score: 0.7, type: 'score' },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
};

const CONTEXT: ClassifierContext = {
  questions: {
    refund: {
      criteria: { false: 'something else', true: 'wants refund' },
      instructions: 'Is the customer asking for money back?',
      type: 'bool',
    },
    route: {
      criteria: { billing: 'Payments', technical: 'Bugs' },
      instructions: 'Which team should handle this?',
      type: 'choice',
    },
    urgency: {
      criteria: [],
      instructions: 'How urgent is this?',
      type: 'score',
    },
  },
  state: { ticket: 'a-1' },
};

async function registerProvider(): Promise<Provider> {
  let capturedProvider: null | Provider = null;
  const mockPi = {
    registerProvider: (provider: Provider): void => {
      capturedProvider = provider;
    },
  };
  const { default: extension } = await import('../index');
  await extension(mockPi as ExtensionAPI);
  return capturedProvider!;
}

function classifiersOf(provider: Provider): ClassifierModel<'typesafe-system-one'>[] {
  return (provider.getAllModels?.() ?? []).filter(
    (model): model is ClassifierModel<'typesafe-system-one'> => model.type === 'classifier',
  );
}

/** Injectable fetch that records every request and answers via `respond`. */
function captureFetch(respond: () => Response | Promise<Response>): {
  captured: CapturedRequest[];
  fetch: typeof globalThis.fetch;
} {
  const captured: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({ init: init ?? {}, url: resolveInputUrl(input) });
    return Promise.resolve(respond());
  };
  return { captured, fetch };
}

/**
 * fetch mock that always rejects with an AbortError, emulating what a real
 * fetch does when its abort signal fires.
 */
const abortingFetch: typeof globalThis.fetch = (): Promise<Response> =>
  Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));

/** Run the laya classifier against `fetch` with a valid test credential. */
async function classifyLaya(
  provider: Provider,
  options: ClassifierOptions,
): Promise<ClassifierResult> {
  const model = classifiersOf(provider).find((entry) => entry.id === 'convaiinnovations/laya');
  if (model === undefined) throw new Error('convaiinnovations/laya classifier was not registered');
  return provider.classify!(model, CONTEXT, options);
}

describe('Classifier model mapping', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(CATALOG_FIXTURE, {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  });

  test('GETs /v1/models and keeps only usable system-one models', async () => {
    const { captured, fetch } = captureFetch(() =>
      Response.json(CATALOG_FIXTURE, {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
    globalThis.fetch = fetch;
    const models = await fetchBergetClassifiers();

    // The live catalog fetch — not the chat listing.
    expect(captured.map((request) => request.url)).toEqual([
      'https://test-api.berget.ai/v1/models',
    ]);
    // Decoy model types and the retired entry are gone; the rest survive.
    expect(models.map((model) => model.id).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Cloudflare/clef-flash',
      'convaiinnovations/laya',
      'Qwen/Qwen3.5-2B',
    ]);
  });

  test('maps catalog values: ids, pricing €/M → per-token, names, context windows', async () => {
    const models = await fetchBergetClassifiers();

    const qwen = models.find((model) => model.id === 'Qwen/Qwen3.5-2B');
    expect(qwen).toEqual({
      api: 'typesafe-system-one',
      baseUrl: 'https://api.berget.ai/v1',
      contextWindow: 262_144,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0.042, output: 0 },
      id: 'Qwen/Qwen3.5-2B',
      input: ['text'],
      name: 'System One (Qwen3.5-2B)',
      provider: 'berget',
      type: 'classifier',
    });

    const laya = models.find((model) => model.id === 'convaiinnovations/laya');
    expect(laya).toMatchObject({ contextWindow: 8192, name: 'System One (laya)' });

    // Clef is a known id — its documented 64K window wins over the default.
    const clef = models.find((model) => model.id === 'Cloudflare/clef-flash');
    expect(clef).toMatchObject({ contextWindow: 65_536, name: 'System One (clef-flash)' });
  });

  test('baseUrl follows BERGET_INFERENCE_URL like chat models do', async () => {
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
    const models = await fetchBergetClassifiers();
    expect(models).toHaveLength(3);
    for (const model of models) {
      expect(model.baseUrl).toBe('https://test-inference.berget.ai');
    }
  });

  test('unknown system-one ids fall back to the default context window', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          { data: [systemOneEntry({ id: 'example/new-classifier' })], object: 'list' },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );
    const models = await fetchBergetClassifiers();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ contextWindow: 8192, id: 'example/new-classifier' });
  });

  test('throws on a non-2xx catalog response', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response('Server error', { status: 500, statusText: 'Internal Server Error' }),
      );
    await expect(fetchBergetClassifiers()).rejects.toThrow(
      'Failed to fetch classifiers: 500 Internal Server Error',
    );
  });

  test('throws on a chat-shaped body served for the catalog URL', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ models: [] }, { status: 200 }));
    await expect(fetchBergetClassifiers()).rejects.toThrow('Malformed model catalog response');
  });
});

describe('Classifier registration', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    installCatalogFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  });

  test('classifiers are registered alongside chat models and stay out of getModels()', async () => {
    const provider = await registerProvider();

    // Chat listing: only /v1/models/chat models — no classifier leakage.
    expect(provider.getModels().map((model) => model.id)).toEqual([
      'meta-llama/Llama-3.3-70B-Instruct',
    ]);

    const classifiers = classifiersOf(provider);
    expect(classifiers.map((model) => model.id).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Cloudflare/clef-flash',
      'convaiinnovations/laya',
      'Qwen/Qwen3.5-2B',
    ]);
    for (const model of classifiers) {
      expect(model.api).toBe('typesafe-system-one');
      expect(model.provider).toBe('berget');
    }
  });

  test('a failing catalog fetch registers the provider without classifiers', async () => {
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      if (resolveInputUrl(input).includes('/v1/models/chat')) {
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
              ],
            },
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('Server error', { status: 500 }));
    };

    const provider = await registerProvider();

    // Chat models survive the degraded catalog; no classifiers are registered.
    expect(provider.getModels().map((model) => model.id)).toEqual([
      'meta-llama/Llama-3.3-70B-Instruct',
    ]);
    expect(classifiersOf(provider)).toEqual([]);
  });

  test('classifiers survive a refreshModels overlay cycle', async () => {
    const provider = await registerProvider();

    // Swap the upstream chat catalog, as the live refresh path would.
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          {
            models: [
              {
                contextWindow: 128_000,
                id: 'openai/gpt-oss-120b',
                inputPricePerToken: 0.000_001,
                outputPricePerToken: 0.000_002,
              },
            ],
          },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );

    let storeWroteModels: unknown = null;
    await provider.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: (publication: { update?: () => void; persist?: unknown }) => {
        publication.update?.();
        if (publication.persist) {
          storeWroteModels = publication.persist;
        }
        return Promise.resolve(true);
      },
      store: {
        read: () => Promise.resolve() as Promise<ModelsStoreEntry | undefined>,
        write: (entry: ModelsStoreEntry) => {
          storeWroteModels = entry;
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
      },
    } as Parameters<NonNullable<Provider['refreshModels']>>[0]);

    // The overlay appended the refreshed chat model (createProvider keeps the
    // baseline and merges the overlay on top — see Risks #1 in
    // docs/persistence-migration.md)...
    const chatIds = provider.getModels().map((model) => model.id);
    expect(chatIds).toContain('openai/gpt-oss-120b');
    expect(chatIds).toContain('meta-llama/Llama-3.3-70B-Instruct');
    // ...the chat listing still contains no classifier ids...
    expect(chatIds).not.toContain('convaiinnovations/laya');
    expect(chatIds).not.toContain('Qwen/Qwen3.5-2B');
    // ...and the fetched classifier baseline survived the merge by type + id.
    expect(
      classifiersOf(provider)
        .map((model) => model.id)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['Cloudflare/clef-flash', 'convaiinnovations/laya', 'Qwen/Qwen3.5-2B']);

    // The persisted overlay is chat-only — classifiers are not duplicated into it.
    const written = storeWroteModels as { models: { type?: string }[] };
    expect(written.models.every((model) => model.type === undefined)).toBe(true);
  });
});

describe('classify dispatch and parsing', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
    installCatalogFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  });

  test('POSTs the System One envelope to <baseUrl>/systemone with Bearer auth', async () => {
    const provider = await registerProvider();
    const { captured, fetch } = captureFetch(() => Response.json(SUCCESS_BODY));

    const result = await classifyLaya(provider, { apiKey: 'test-key', fetch, maxRetries: 0 });

    expect(result.stopReason).toBe('stop');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://test-inference.berget.ai/systemone');
    expect(captured[0]?.init.method).toBe('POST');

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(headers['content-type']).toBe('application/json');

    // The envelope sends the model id, the state verbatim, and public `bool`
    // questions as wire-level `noul` (choice/score pass through unchanged).
    const payload = JSON.parse(captured[0]?.init.body as string) as Record<string, unknown>;
    expect(payload.model).toBe('convaiinnovations/laya');
    expect(payload.state).toEqual({ ticket: 'a-1' });
    expect(payload.questions).toEqual({
      refund: {
        criteria: { false: 'something else', true: 'wants refund' },
        instructions: 'Is the customer asking for money back?',
        type: 'noul',
      },
      route: {
        criteria: { billing: 'Payments', technical: 'Bugs' },
        instructions: 'Which team should handle this?',
        type: 'choice',
      },
      urgency: { criteria: [], instructions: 'How urgent is this?', type: 'score' },
    });
  });

  test('parses noul/choice/score answers and prices token usage at the catalog cost', async () => {
    const provider = await registerProvider();
    const { fetch } = captureFetch(() => Response.json(SUCCESS_BODY));

    const result = await classifyLaya(provider, { apiKey: 'test-key', fetch, maxRetries: 0 });

    expect(result.stopReason).toBe('stop');
    expect(result.provider).toBe('berget');
    expect(result.model).toBe('convaiinnovations/laya');
    expect(result.api).toBe('typesafe-system-one');

    // Wire `noul` → public bool with `probability`.
    expect(result.answers.refund).toEqual({ probability: 0.93, type: 'bool' });
    expect(result.answers.route).toEqual({
      choice: 'billing',
      confidence: 0.85,
      probabilities: { billing: 0.8, technical: 0.2 },
      type: 'choice',
    });
    expect(result.answers.urgency).toEqual({ confidence: 0.9, score: 0.7, type: 'score' });

    // Usage: 100 input tokens at the registered €0.042/M input cost.
    expect(result.usage?.input).toBe(100);
    expect(result.usage?.output).toBe(0);
    expect(result.usage?.totalTokens).toBe(100);
    expect(result.usage?.cost.input).toBeCloseTo(4.2e-6, 12);
    expect(result.usage?.cost.output).toBe(0);
  });

  test('resolves with stopReason error on a non-2xx response', async () => {
    const provider = await registerProvider();
    const { fetch } = captureFetch(() => new Response('Unauthorized', { status: 401 }));

    const result = await classifyLaya(provider, { apiKey: 'test-key', fetch, maxRetries: 0 });

    expect(result.stopReason).toBe('error');
    expect(result.answers).toEqual({});
    expect(result.errorMessage).toBeDefined();
  });

  test('resolves with stopReason error when the service omits an answer', async () => {
    const provider = await registerProvider();
    const { fetch } = captureFetch(() =>
      Response.json({ answers: { refund: SUCCESS_BODY.answers.refund } }),
    );

    const result = await classifyLaya(provider, { apiKey: 'test-key', fetch, maxRetries: 0 });

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBeDefined();
  });

  test('resolves with stopReason error without a credential — no request is sent', async () => {
    const provider = await registerProvider();
    const captured: CapturedRequest[] = [];
    const fetch: typeof globalThis.fetch = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.push({ init: init ?? {}, url: resolveInputUrl(input) });
      return Promise.resolve(Response.json(SUCCESS_BODY));
    };

    const result = await classifyLaya(provider, { fetch, maxRetries: 0 });

    expect(result.stopReason).toBe('error');
    expect(captured).toHaveLength(0);
  });

  test('resolves with stopReason aborted when the request is aborted', async () => {
    const provider = await registerProvider();
    // Emulate a real abort: fetch rejects with an AbortError when the signal fires.
    const result = await classifyLaya(provider, {
      fetch: abortingFetch,
      maxRetries: 0,
      signal: AbortSignal.abort(),
    });

    expect(result.stopReason).toBe('aborted');
  });
});
