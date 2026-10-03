import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolveInputUrl } from '../index';
import type { OmpProviderConfig } from '../omp';

/** Captured shape of the config-based registerProvider(name, config) call. */
type CapturedOmpConfig = OmpProviderConfig;

function mockCatalogFetch(models: { id: string }[] | null): void {
  globalThis.fetch = (): Promise<Response> => {
    if (models === null) {
      return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
    }
    return Promise.resolve(
      Response.json(
        {
          models: models.map((model) => ({
            contextWindow: 128_000,
            id: model.id,
            inputPricePerToken: 0.000_000_3,
            outputPricePerToken: 0.000_001_5,
          })),
        },
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
  };
}

describe('OMP Extension Entry Point', () => {
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

  test('registerProvider is called with the config-based berget provider', async () => {
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    mockCatalogFetch([{ id: 'meta-llama/Llama-3.3-70B-Instruct' }]);

    let capturedName: null | string = null;
    let capturedConfig: CapturedOmpConfig | null = null;
    const mockPi = {
      registerProvider: (name: string, config: CapturedOmpConfig): void => {
        capturedName = name;
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../omp');
    await extension(mockPi);

    expect(capturedName).toBe('berget');
    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!.name).toBe('Berget AI');
    expect(capturedConfig!.api).toBe('openai-completions');
    // Environment variable reference (no '$' prefix): OMP resolves config
    // values against the environment first.
    expect(capturedConfig!.apiKey).toBe('BERGET_API_KEY');
    expect(capturedConfig!.authHeader).toBe(true);
    expect(capturedConfig!.baseUrl).toBe('https://test-inference.berget.ai');
    expect(capturedConfig!.models).toHaveLength(1);
    expect(capturedConfig!.models![0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(typeof capturedConfig!.fetchDynamicModels).toBe('function');
    expect(capturedConfig!.oauth!.name).toBe('Berget AI');
    expect(typeof capturedConfig!.oauth!.login).toBe('function');
    expect(typeof capturedConfig!.oauth!.refreshToken).toBe('function');
    expect(typeof capturedConfig!.oauth!.getApiKey).toBe('function');
  });

  test('fetchDynamicModels re-runs live discovery', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    let modelsCallCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = resolveInputUrl(input);
      if (url.includes('/v1/models/chat')) {
        modelsCallCount += 1;
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

    let capturedConfig: CapturedOmpConfig | null = null;
    const mockPi = {
      registerProvider: (_name: string, config: CapturedOmpConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../omp');
    await extension(mockPi);

    expect(modelsCallCount).toBe(1);
    expect(capturedConfig!.models![0].id).toBe('openai/gpt-oss-120b');

    const refreshed = await capturedConfig!.fetchDynamicModels!();
    expect(modelsCallCount).toBe(2);
    expect(refreshed[0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
  });

  test('oauth.getApiKey returns the access token', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    mockCatalogFetch([]);

    let capturedConfig: CapturedOmpConfig | null = null;
    const mockPi = {
      registerProvider: (_name: string, config: CapturedOmpConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../omp');
    await extension(mockPi);

    const credential = { access: 'my-access-token', expires: Date.now() + 60_000, refresh: 'r' };
    expect(capturedConfig!.oauth!.getApiKey!(credential)).toBe('my-access-token');
  });

  test('oauth.refreshToken posts the stored refresh token', async () => {
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

    let capturedConfig: CapturedOmpConfig | null = null;
    const mockPi = {
      registerProvider: (_name: string, config: CapturedOmpConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../omp');
    await extension(mockPi);

    const refreshed = await capturedConfig!.oauth!.refreshToken!(
      {
        access: 'old-access-token',
        expires: Date.now() - 1000,
        refresh: 'old-refresh-token',
      },
      new AbortController().signal,
    );

    expect(capturedBody).toContain('old-refresh-token');
    expect(refreshed.access).toBe('new-access-token');
    expect(refreshed.refresh).toBe('new-refresh-token');
  });

  test('extension throws if model fetch fails (does not register)', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
    mockCatalogFetch(null);

    let registerCalled = false;
    const mockPi = {
      registerProvider: (): void => {
        registerCalled = true;
      },
    };

    const { default: extension } = await import('../omp');
    await expect(extension(mockPi)).rejects.toThrow('Failed to fetch models');
    expect(registerCalled).toBe(false);
  });
});
