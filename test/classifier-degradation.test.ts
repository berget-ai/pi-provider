/**
 * Graceful degradation when pi does not expose the System One transport.
 *
 * Pi's extension loader only aliases a fixed set of pi-ai entry points (root,
 * `/compat`, `/oauth`, `/providers/all`). On such hosts the dynamic import of
 * `@earendil-works/pi-ai/api/typesafe-system-one` rejects — simulated here by
 * a throwing module mock. The extension must still load and register the chat
 * provider, just without classifier models or a `classify` implementation.
 */
import type { Provider } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/api/typesafe-system-one', () => {
  throw new Error("Cannot find module '@earendil-works/pi-ai/api/typesafe-system-one'");
});

describe('Classifier degradation (transport not exposed by host pi)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
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

  test('extension loads and registers the chat provider without classifiers', async () => {
    let capturedProvider: null | Provider = null;
    const mockPi = {
      registerProvider: (provider: Provider): void => {
        capturedProvider = provider;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    expect(capturedProvider).not.toBeNull();
    expect(capturedProvider!.id).toBe('berget');
    // No classifier transport → no classifier models in the catalog and no
    // classify implementation on the provider.
    const classifiers = (capturedProvider!.getAllModels?.() ?? []).filter(
      (model) => model.type === 'classifier',
    );
    expect(classifiers).toEqual([]);
    // Reflect.get avoids the unbound-method lint rule on the optional method.
    expect(Reflect.get(capturedProvider!, 'classify')).toBeUndefined();
    // Chat models are unaffected.
    expect(capturedProvider!.getModels().length).toBeGreaterThan(0);
  });
});
