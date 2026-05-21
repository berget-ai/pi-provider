import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildAuthUrl,
  fetchBergetModels,
  generatePKCE,
  isAuthenticationError,
  oauthResponseHtml,
} from '../index';

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

  // --- Issue 7: PKCE verifier uses more than minimum bytes ---

  test('generatePKCE produces verifier with at least 128 random bytes', async () => {
    const { verifier } = await generatePKCE();
    // 128 random bytes → base64url ≈ 171 chars (256 bits → 43 chars min)
    expect(verifier.length).toBeGreaterThanOrEqual(170);
  });

  // --- Issue 11: fetchBergetModels response validation ---

  test('fetchBergetModels throws clear error when response lacks models array', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> =>
      Response.json({ error: 'Internal Server Error' }, { status: 200 });

    await expect(fetchBergetModels()).rejects.toThrow(
      'Malformed model list response: expected { models: [...] }',
    );
  });

  test('fetchBergetModels throws when models is not an array', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> =>
      Response.json({ models: 'not-an-array' }, { status: 200 });

    await expect(fetchBergetModels()).rejects.toThrow(
      'Malformed model list response: expected { models: [...] }',
    );
  });

  // --- Issue 12: isAuthenticationError fuzzy matching ---

  test('isAuthenticationError does NOT trigger on assistant text mentioning 401', () => {
    const normalChunk = new TextEncoder().encode(
      'The HTTP 401 status code indicates an authentication failure.',
    );
    expect(isAuthenticationError(normalChunk)).toBe(false);
  });

  test('isAuthenticationError DOES trigger on actual SSE authentication_error frame', () => {
    const authChunk = new TextEncoder().encode(
      'data: {"error":{"message":"Invalid token","type":"authentication_error"}}\n\n',
    );
    expect(isAuthenticationError(authChunk)).toBe(true);
  });
});
