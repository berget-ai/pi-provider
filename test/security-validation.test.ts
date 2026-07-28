import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildAuthUrl, fetchBergetModels, generatePKCE, oauthResponseHtml } from '../index';

describe('Security hardening & input validation', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
    vi.clearAllMocks();
  });

  // --- Issue 4: XSS in OAuth callback error page ---

  test('oauthResponseHtml escapes script tags', () => {
    const html = oauthResponseHtml(false, '<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('oauthResponseHtml escapes ampersands, double quotes, and greater-than', () => {
    const html = oauthResponseHtml(false, 'A & B "test" < >');
    expect(html).toContain('A &amp; B &quot;test&quot; &lt; &gt;');
  });

  // --- Issue 6: Redirect URI uses 127.0.0.1 instead of localhost ---

  test('buildAuthUrl uses 127.0.0.1 in redirect_uri', () => {
    process.env.BERGET_AUTH_URL = 'https://keycloak.berget.ai';
    const url = buildAuthUrl('challenge123', 'state456');
    expect(url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback');
  });

  // --- Issue 7: PKCE verifier is spec-compliant ---

  test('generatePKCE produces a verifier within the RFC 7636 length limits', async () => {
    const { verifier } = await generatePKCE();
    // RFC 7636 requires code_verifier length between 43 and 128 characters.
    // 96 random bytes → base64url is 128 chars, the maximum allowed length.
    expect(verifier).toHaveLength(128);
  });

  // --- Issue 11: fetchBergetModels response validation ---

  test('fetchBergetModels throws clear error when response lacks models array', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ error: 'Internal Server Error' }, { status: 200 }));

    await expect(fetchBergetModels()).rejects.toThrow(
      'Malformed model list response: expected { models: [...] }',
    );
  });

  test('fetchBergetModels throws when models is not an array', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ models: 'not-an-array' }, { status: 200 }));

    await expect(fetchBergetModels()).rejects.toThrow(
      'Malformed model list response: expected { models: [...] }',
    );
  });

  // --- Entry-level validation: numeric fields are informational, so a bad
  // value must not block the user from using the model. ---

  test('fetchBergetModels coerces a missing inputPricePerToken to 0 (loads the model, no NaN)', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          {
            models: [
              {
                contextWindow: 128_000,
                id: 'unpriced-model',
                outputPricePerToken: 0.000_000_3,
              },
            ],
          },
          { status: 200 },
        ),
      );

    const models = await fetchBergetModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('unpriced-model');
    expect(models[0].cost.input).toBe(0);
    expect(models[0].cost.output).toBeCloseTo(0.3);
    expect(Number.isNaN(models[0].cost.input)).toBe(false);
  });

  test('fetchBergetModels coerces a non-numeric contextWindow to 0', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          {
            models: [
              {
                contextWindow: '128000',
                id: 'bad-context-model',
                inputPricePerToken: 0.000_000_3,
                outputPricePerToken: 0.000_000_3,
              },
            ],
          },
          { status: 200 },
        ),
      );

    const models = await fetchBergetModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('bad-context-model');
    expect(models[0].contextWindow).toBe(0);
  });

  test('fetchBergetModels drops an entry that has no valid id', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          {
            models: [
              {
                contextWindow: 128_000,
                inputPricePerToken: 0.000_000_3,
                outputPricePerToken: 0.000_000_3,
              },
              {
                contextWindow: 64_000,
                id: 'real-model',
                inputPricePerToken: 0.000_000_3,
                outputPricePerToken: 0.000_000_3,
              },
            ],
          },
          { status: 200 },
        ),
      );

    const models = await fetchBergetModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('real-model');
  });

  test('fetchBergetModels accepts an entry with extra fields (aliases, lifecycleState)', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          {
            models: [
              {
                aliases: ['alias-1'],
                contextWindow: 128_000,
                id: 'openai/gpt-oss-120b',
                inputPricePerToken: 0.000_001,
                lifecycleState: 'stable',
                outputPricePerToken: 0.000_002,
              },
            ],
          },
          { status: 200 },
        ),
      );

    const models = await fetchBergetModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openai/gpt-oss-120b');
    expect(models[0].cost.input).toBe(1);
    expect(models[0].cost.output).toBe(2);
  });
});
