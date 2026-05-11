import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

describe('Extension Entry Point', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('registerProvider is called with correct config', async () => {
    process.env.BERGET_INFERENCE_URL = 'https://test-inference.berget.ai';
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          models: [
            {
              contextWindow: 128000,
              id: 'meta-llama/Llama-3.3-70B-Instruct',
              inputPricePerToken: 0.0000003,
              outputPricePerToken: 0.0000015,
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
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
    expect(capturedConfig!.apiKey).toBe('BERGET_API_KEY');
    expect(capturedConfig!.models).toHaveLength(1);
    expect(capturedConfig!.models![0].id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(capturedConfig!.models![0].compat).toEqual({ supportsDeveloperRole: false });
    expect(capturedConfig!.oauth).toBeDefined();
    expect(capturedConfig!.oauth!.name).toBe('Berget AI');
    expect(capturedConfig!.oauth!.login).toBeTypeOf('function');
    expect(capturedConfig!.oauth!.refreshToken).toBeTypeOf('function');
    expect(capturedConfig!.oauth!.getApiKey).toBeTypeOf('function');
  });

  test('oauth.getApiKey returns cred.access', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ models: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    };

    let capturedConfig: null | ProviderConfig = null;

    const mockPi = {
      registerProvider: (_name: string, config: ProviderConfig): void => {
        capturedConfig = config;
      },
    };

    const { default: extension } = await import('../index');
    await extension(mockPi as ExtensionAPI);

    const cred = { access: 'my-access-token', expires: Date.now() + 60000, refresh: 'r' };
    expect(capturedConfig!.oauth!.getApiKey(cred)).toBe('my-access-token');
  });

  test('extension throws if model fetch fails (does not register)', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> => {
      return new Response('Internal Server Error', { status: 500 });
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

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          models: [
            { contextWindow: 32000, id: 'model-a', inputPricePerToken: 0, outputPricePerToken: 0 },
            {
              contextWindow: 128000,
              id: 'model-b',
              inputPricePerToken: 0.000001,
              outputPricePerToken: 0.000003,
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
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
});
