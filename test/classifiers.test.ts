/**
 * Tests for the Berget System One classifier models (issue #69).
 *
 * Coverage:
 *
 * 1. `getBergetClassifierModels()` mapping: static entries, ids, cost,
 *    context windows, and the `BERGET_INFERENCE_URL` override.
 * 2. Registration: the classifiers baseline is exposed via `getAllModels()`,
 *    kept out of chat-only `getModels()`, and survives a `refreshModels`
 *    overlay cycle (createProvider merges baseline + overlay by type + id).
 * 3. Dispatch envelope: `provider.classify` POSTs the TypeSafe System One
 *    shape to `<baseUrl>/systemone` with Bearer auth, sending public `bool`
 *    questions as wire-level `noul`.
 * 4. Answer/usage parsing: wire `noul`/`choice`/`score` back to public answer
 *    types; token usage priced at the model's catalog cost.
 * 5. Error paths: non-2xx, missing answer, missing credential, and abort all
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

import { getBergetClassifierModels, resolveInputUrl } from '../index';

interface CapturedRequest {
  init: RequestInit;
  url: string;
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

/** Run the laya-latest classifier against `fetch` with a valid test credential. */
async function classifyLaya(
  provider: Provider,
  options: ClassifierOptions,
): Promise<ClassifierResult> {
  const model = classifiersOf(provider).find((entry) => entry.id === 'laya-latest');
  if (model === undefined) throw new Error('laya-latest classifier was not registered');
  return provider.classify!(model, CONTEXT, options);
}

describe('Classifier model mapping', () => {
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnvironment = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  test('returns the two System One models with catalog values', () => {
    const models = getBergetClassifierModels();
    expect(models.map((model) => model.id).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'laya-latest',
      'systemone',
    ]);

    const laya = models.find((model) => model.id === 'laya-latest');
    const systemone = models.find((model) => model.id === 'systemone');
    expect(laya).toEqual({
      api: 'typesafe-system-one',
      baseUrl: 'https://api.berget.ai/v1',
      contextWindow: 8192,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0.042, output: 0 },
      id: 'laya-latest',
      input: ['text'],
      name: 'System One (Laya multilingual)',
      provider: 'berget',
      type: 'classifier',
    });
    expect(systemone).toEqual({
      api: 'typesafe-system-one',
      baseUrl: 'https://api.berget.ai/v1',
      contextWindow: 262_144,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0.042, output: 0 },
      id: 'systemone',
      input: ['text'],
      name: 'System One (Qwen3.5 2B)',
      provider: 'berget',
      type: 'classifier',
    });
  });

  test('baseUrl follows BERGET_INFERENCE_URL like chat models do', () => {
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
    const models = getBergetClassifierModels();
    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(model.baseUrl).toBe('https://test-inference.berget.ai');
    }
  });
});

describe('Classifier registration', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
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
      'laya-latest',
      'systemone',
    ]);
    for (const model of classifiers) {
      expect(model.api).toBe('typesafe-system-one');
      expect(model.provider).toBe('berget');
    }
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
    expect(chatIds).not.toContain('laya-latest');
    expect(chatIds).not.toContain('systemone');
    // ...and the static classifier baseline survived the merge by type + id.
    expect(
      classifiersOf(provider)
        .map((model) => model.id)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['laya-latest', 'systemone']);

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
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ models: [] }, { status: 200 }));
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
    expect(payload.model).toBe('laya-latest');
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
    expect(result.model).toBe('laya-latest');
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
