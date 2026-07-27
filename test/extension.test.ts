import type { ModelsStoreEntry, Provider } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolveInputUrl } from '../index';

describe('Extension Entry Point', () => {
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

  test('registerProvider is called with correct provider', async () => {
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> => {
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
    };

    let capturedProvider: null | Provider = null;

    const mockPi = {
      // object-form: registerProvider(provider: Provider)
      registerProvider: (provider: Provider): void => {
        capturedProvider = provider;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    expect(capturedProvider).not.toBeNull();
    expect(capturedProvider!.id).toBe('berget');
    expect(capturedProvider!.name).toBe('Berget AI');
    expect(capturedProvider!.baseUrl).toBe('https://test-inference.berget.ai');
    // createProvider exposes the catalog via getModels(); the startup fetch
    // populated the baseline list.
    expect(typeof capturedProvider!.getModels).toBe('function');
    const models = capturedProvider!.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(models[0].compat).toEqual({ supportsDeveloperRole: false });
    expect(models[0].api).toBe('openai-completions');
    expect(models[0].provider).toBe('berget');
    // Both auth paths are wired.
    expect(capturedProvider!.auth.apiKey).toBeDefined();
    expect(capturedProvider!.auth.oauth).toBeDefined();
    expect(capturedProvider!.auth.oauth!.name).toBe('Berget AI');
    expect(typeof capturedProvider!.auth.oauth!.login).toBe('function');
    expect(typeof capturedProvider!.auth.oauth!.refresh).toBe('function');
    expect(typeof capturedProvider!.auth.oauth!.toAuth).toBe('function');
    // fetchModels is the ModelsStore-persisted refresh path.
    expect(typeof capturedProvider!.refreshModels).toBe('function');
  });

  test('oauth.toAuth returns the access token as the request apiKey', async () => {
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

    let capturedProvider: null | Provider = null;

    const mockPi = {
      registerProvider: (provider: Provider): void => {
        capturedProvider = provider;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    // toAuth replaces the legacy getApiKey: the stored access token becomes
    // the request apiKey. It is async (covers lazy OAuth wrappers).
    const cred = {
      access: 'my-access-token',
      expires: Date.now() + 60_000,
      refresh: 'r',
      type: 'oauth' as const,
    };
    const auth = await capturedProvider!.auth.oauth!.toAuth(cred);
    expect(auth.apiKey).toBe('my-access-token');
  });

  test('oauth.refresh refreshes the credentials it receives', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    let capturedBody: null | string = null;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = resolveInputUrl(input);
      if (url.includes('/v1/models/chat')) {
        return Promise.resolve(
          Response.json({ models: [] }, { headers: { 'Content-Type': 'application/json' } }),
        );
      }
      if (url.includes('/v1/auth/refresh')) {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(
          Response.json(
            { expires_in: 300, refresh_token: 'new-refresh-token', token: 'new-access-token' },
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('Not found', { status: 404 }));
    };

    let capturedProvider: null | Provider = null;
    const mockPi = {
      registerProvider: (provider: Provider): void => {
        capturedProvider = provider;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    // oauth.refresh replaces the legacy refreshToken (same refresh_token
    // request, now (credential, signal?) -> OAuthCredential).
    const refreshed = await capturedProvider!.auth.oauth!.refresh({
      access: 'old-access-token',
      expires: Date.now() - 1000,
      refresh: 'old-refresh-token',
      type: 'oauth',
    });

    expect(capturedBody).toContain('old-refresh-token');
    expect(refreshed.access).toBe('new-access-token');
    expect(refreshed.refresh).toBe('new-refresh-token');
  });

  test('extension throws if model fetch fails (does not register)', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> => {
      return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
    };

    let registerCalled = false;
    const mockPi = {
      registerProvider: (): void => {
        registerCalled = true;
      },
    };

    const { default: extension } = await import('../index');
    await expect(extension(mockPi as unknown as ExtensionAPI)).rejects.toThrow(
      'Failed to fetch models',
    );
    expect(registerCalled).toBe(false);
  });

  test('all models have compat.supportsDeveloperRole = false', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> => {
      return Promise.resolve(
        Response.json(
          {
            models: [
              {
                contextWindow: 32_000,
                id: 'model-a',
                inputPricePerToken: 0,
                outputPricePerToken: 0,
              },
              {
                contextWindow: 128_000,
                id: 'model-b',
                inputPricePerToken: 0.000_001,
                outputPricePerToken: 0.000_003,
              },
            ],
          },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );
    };

    let capturedProvider: null | Provider = null;
    const mockPi = {
      registerProvider: (provider: Provider): void => {
        capturedProvider = provider;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    for (const model of capturedProvider!.getModels()) {
      expect(model.compat).toEqual({ supportsDeveloperRole: false });
    }
  });

  test('refreshModels is registered and re-runs live discovery into the store', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    let modelsCallCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = resolveInputUrl(input);
      if (url.includes('/v1/models/chat')) {
        modelsCallCount += 1;
        // The factory's fetch returns gpt-oss-120b; refreshModels's fetch
        // returns a different list (model swapped) to prove the refresh path
        // re-runs fetchBergetModels rather than replaying the startup list.
        const id =
          modelsCallCount === 1 ? 'openai/gpt-oss-120b' : 'meta-llama/Llama-3.3-70B-Instruct';
        return Promise.resolve(
          Response.json(
            {
              models: [
                {
                  contextWindow: 128_000,
                  id,
                  inputPricePerToken: 0.000_001,
                  outputPricePerToken: 0.000_002,
                },
              ],
            },
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('Not found', { status: 404 }));
    };

    let capturedProvider: null | Provider = null;
    const mockPi = {
      registerProvider: (provider: Provider): void => {
        capturedProvider = provider;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    // Startup: one fetch, the baseline list published by createProvider is
    // gpt-oss-120b.
    expect(modelsCallCount).toBe(1);
    expect(typeof capturedProvider!.refreshModels).toBe('function');
    expect(capturedProvider!.getModels()[0].id).toBe('openai/gpt-oss-120b');

    // refreshModels: createProvider's fetchModels-backed refresh re-runs
    // fetchBergetModels (second fetch), then persists the result through the
    // provided store (store.write). It resolves to undefined; the merged
    // catalog is observable via getModels().
    let storeWroteModels: unknown = null;
    await capturedProvider!.refreshModels!({
      allowNetwork: true,
      store: {
        read: () => Promise.resolve() as Promise<ModelsStoreEntry | undefined>,
        write: (entry) => {
          storeWroteModels = entry;
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
      },
    });
    expect(modelsCallCount).toBe(2);
    // createProvider persists the fetched Model[] through the store.
    expect(storeWroteModels).not.toBeNull();
    const written = storeWroteModels as { models: { id: string }[]; checkedAt: number };
    expect(written.models).toHaveLength(1);
    expect(written.models[0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(typeof written.checkedAt).toBe('number');
    // The merged catalog (baseline over-written by id, new dynamic ids
    // appended) now contains the refreshed model — it appears alongside the
    // baseline gpt-oss-120b because the ids differ (see Risks #1: a model
    // removed upstream lingers in the baseline until the next createProvider).
    const mergedIds = capturedProvider!.getModels().map((m) => m.id);
    expect(mergedIds).toContain('meta-llama/Llama-3.3-70B-Instruct');
    expect(mergedIds).toContain('openai/gpt-oss-120b');
  });
});
