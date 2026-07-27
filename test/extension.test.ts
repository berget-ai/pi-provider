import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

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

  test('registerProvider is called with correct config', async () => {
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

    let capturedName: null | string = null;
    let capturedConfig: null | ProviderConfig = null;

    const mockPi = {
      registerProvider: (_name: string, config: ProviderConfig): void => {
        capturedName = _name;
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    expect(capturedName).toBe('berget');
    expect(capturedConfig!.name).toBe('Berget AI');
    expect(capturedConfig!.baseUrl).toBe('https://test-inference.berget.ai');
    expect(capturedConfig!.api).toBe('openai-completions');
    expect(capturedConfig!.apiKey).toBe('$BERGET_API_KEY');
    expect(capturedConfig!.models).toHaveLength(1);
    expect(capturedConfig!.models![0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(capturedConfig!.models![0].compat).toEqual({ supportsDeveloperRole: false });
    expect(capturedConfig!.oauth).toBeDefined();
    expect(capturedConfig!.oauth!.name).toBe('Berget AI');
    expect(typeof capturedConfig!.oauth!.login).toBe('function');
    expect(typeof capturedConfig!.oauth!.refreshToken).toBe('function');
    expect(typeof capturedConfig!.oauth!.getApiKey).toBe('function');
  });

  test('oauth.getApiKey returns cred.access', async () => {
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

    let capturedConfig: null | ProviderConfig = null;

    const mockPi = {
      registerProvider: (_name: string, config: ProviderConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    const cred = { access: 'my-access-token', expires: Date.now() + 60_000, refresh: 'r' };
    expect(capturedConfig!.oauth!.getApiKey(cred)).toBe('my-access-token');
  });

  test('oauth.refreshToken refreshes the credentials it receives', async () => {
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

    let capturedConfig: null | ProviderConfig = null;
    const mockPi = {
      registerProvider: (_name: string, config: ProviderConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    const refreshed = await capturedConfig!.oauth!.refreshToken({
      access: 'old-access-token',
      expires: Date.now() - 1000,
      refresh: 'old-refresh-token',
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

    let capturedConfig: null | ProviderConfig = null;
    const mockPi = {
      registerProvider: (_name: string, config: ProviderConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    for (const model of capturedConfig!.models!) {
      expect(model.compat).toEqual({ supportsDeveloperRole: false });
    }
  });

  test('refreshModels is registered and re-runs live discovery', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    let modelsCallCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = resolveInputUrl(input);
      if (url.includes('/v1/models/chat')) {
        modelsCallCount += 1;
        // The factory's fetch returns gpt-oss-120b; refreshModels's fetch
        // returns a different list (model swapped + count changed) to prove
        // the refresh path re-runs fetchBergetModels rather than replaying
        // the startup list.
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

    let capturedConfig: null | ProviderConfig = null;
    const mockPi = {
      registerProvider: (_name: string, config: ProviderConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    // Startup: one fetch, the published startup list is gpt-oss-120b.
    expect(modelsCallCount).toBe(1);
    expect(capturedConfig!.models).toHaveLength(1);
    expect(capturedConfig!.models![0].id).toBe('openai/gpt-oss-120b');
    expect(typeof capturedConfig!.refreshModels).toBe('function');

    // refreshModels: a second live fetch, returning a different catalog. The
    // store stub satisfies RefreshModelsContext's required `store`; the
    // minimal refreshModels does not read or write the store.
    const refreshed = await capturedConfig!.refreshModels!({
      allowNetwork: true,
      store: {
        read: () => Promise.resolve() as Promise<undefined>,
        write: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
    });
    expect(modelsCallCount).toBe(2);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
  });
});
