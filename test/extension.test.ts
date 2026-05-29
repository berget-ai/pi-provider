import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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

    globalThis.fetch = async (): Promise<Response> => {
      return Response.json(
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
    expect(capturedConfig!.oauth!.login).toBeTypeOf('function');
    expect(capturedConfig!.oauth!.refreshToken).toBeTypeOf('function');
    expect(capturedConfig!.oauth!.getApiKey).toBeTypeOf('function');
  });

  test('oauth.getApiKey returns cred.access', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> => {
      return Response.json(
        { models: [] },
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
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
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/models/chat')) {
        return Response.json({ models: [] }, { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/auth/refresh')) {
        capturedBody = String(init?.body ?? '');
        return Response.json(
          { expires_in: 300, refresh_token: 'new-refresh-token', token: 'new-access-token' },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
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
      return Response.json(
        {
          models: [
            { contextWindow: 32_000, id: 'model-a', inputPricePerToken: 0, outputPricePerToken: 0 },
            {
              contextWindow: 128_000,
              id: 'model-b',
              inputPricePerToken: 0.000_001,
              outputPricePerToken: 0.000_003,
            },
          ],
        },
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
