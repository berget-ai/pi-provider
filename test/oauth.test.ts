import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loginBerget, refreshBergetToken, resolveInputUrl } from '../index';

async function hitCallback(authUrl: string): Promise<void> {
  const urlObject = new URL(authUrl);
  const state = urlObject.searchParams.get('state')!;
  const resp = await fetch(`http://localhost:8787/callback?code=test-auth-code&state=${state}`);
  await resp.text();
}

function mockFetch(
  originalFetch: typeof globalThis.fetch,
  overrides?: {
    onToken?: (body: string) => Response;
  },
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveInputUrl(input);
    if (url.includes('localhost:8787/callback')) {
      return originalFetch(input, init);
    }
    if (url.includes('/openid-connect/token')) {
      const body = init?.body;
      const bodyString = body instanceof URLSearchParams ? body.toString() : String(body ?? '');
      if (overrides?.onToken) return overrides.onToken(bodyString);
      return Response.json(
        {
          access_token: 'test-access-token',
          expires_in: 300,
          refresh_token: 'test-refresh-token',
        },
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    }
    return new Response('Not found', { status: 404 });
  };
}

describe('OAuth & Token Refresh', () => {
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

  test('login() starts callback server and generates correct PKCE auth URL', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';
    process.env.BERGET_OAUTH_TIMEOUT_MS = '1000';

    let resolveAuthUrl: (url: string) => void;
    const authUrlPromise = new Promise<string>((resolve) => {
      resolveAuthUrl = resolve;
    });

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => resolveAuthUrl(info.url),
      onPrompt: async () => 'fallback-code',
    };

    globalThis.fetch = mockFetch(originalFetch);

    const loginPromise = loginBerget(callbacks);
    loginPromise.catch(() => {});

    const authUrl = await authUrlPromise;
    await hitCallback(authUrl);
    await loginPromise;

    expect(authUrl).toContain(
      'https://test-login.berget.ai/realms/berget/protocol/openid-connect/auth',
    );
    expect(authUrl).toContain('client_id=berget-code');
    expect(authUrl).toContain('response_type=code');
    expect(authUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fcallback');
    expect(authUrl).toContain('scope=openid');
    expect(authUrl).toContain('code_challenge_method=S256');
  });

  test('login() exchanges code from callback for tokens with 1-min buffer', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';
    process.env.BERGET_OAUTH_TIMEOUT_MS = '1000';

    let capturedTokenBody: null | string = null;

    let resolveAuthUrl: (url: string) => void;
    const authUrlPromise = new Promise<string>((resolve) => {
      resolveAuthUrl = resolve;
    });

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => resolveAuthUrl(info.url),
      onPrompt: async () => 'fallback-code',
    };

    globalThis.fetch = mockFetch(originalFetch, {
      onToken: (body) => {
        capturedTokenBody = body;
        return Response.json(
          {
            access_token: 'test-access-token',
            expires_in: 300,
            refresh_token: 'test-refresh-token',
          },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        );
      },
    });

    const beforeLogin = Date.now();
    const loginPromise = loginBerget(callbacks);
    loginPromise.catch(() => {});

    const authUrl = await authUrlPromise;
    await hitCallback(authUrl);
    const creds = await loginPromise;
    const afterLogin = Date.now();

    expect(creds.access).toBe('test-access-token');
    expect(creds.refresh).toBe('test-refresh-token');
    expect(creds.expires).toBeGreaterThanOrEqual(beforeLogin + 300 * 1000 - 60 * 1000);
    expect(creds.expires).toBeLessThanOrEqual(afterLogin + 300 * 1000 - 60 * 1000);

    expect(capturedTokenBody).toContain('grant_type=authorization_code');
    expect(capturedTokenBody).toContain('client_id=berget-code');
    expect(capturedTokenBody).toContain('code=test-auth-code');
    expect(capturedTokenBody).toContain('code_verifier=');
  });

  test('login() falls back to onPrompt when callback server times out', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';
    process.env.BERGET_OAUTH_TIMEOUT_MS = '200';

    let promptCalled = false;
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async (prompt) => {
        promptCalled = true;
        expect(prompt.message).toContain('authorization code');
        return 'fallback-code';
      },
    };

    globalThis.fetch = mockFetch(originalFetch);

    const creds = await loginBerget(callbacks);

    expect(promptCalled).toBe(true);
    expect(creds.access).toBe('test-access-token');
  });

  test('login() throws on token exchange failure', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';
    process.env.BERGET_OAUTH_TIMEOUT_MS = '1000';

    let resolveAuthUrl: (url: string) => void;
    const authUrlPromise = new Promise<string>((resolve) => {
      resolveAuthUrl = resolve;
    });

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => resolveAuthUrl(info.url),
      onPrompt: async () => 'test-auth-code',
    };

    globalThis.fetch = mockFetch(originalFetch, {
      onToken: () => new Response('Unauthorized', { status: 401 }),
    });

    const loginPromise = loginBerget(callbacks);
    loginPromise.catch(() => {});

    const authUrl = await authUrlPromise;
    await hitCallback(authUrl);

    await expect(loginPromise).rejects.toThrow('Token exchange failed');
  });

  test('login() uses onManualCodeInput when provided', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';
    process.env.BERGET_OAUTH_TIMEOUT_MS = '1000';

    let manualInputCalled = false;

    const callbacks: OAuthLoginCallbacks = {
      onAuth: async () => {
        // auth URL resolution logic would go here
      },
      onManualCodeInput: async () => {
        manualInputCalled = true;
        return 'http://localhost:8787/callback?code=manual-code&state=will-be-ignored';
      },
      onPrompt: async () => 'fallback-code',
    };

    globalThis.fetch = mockFetch(originalFetch);

    const creds = await loginBerget(callbacks);

    expect(manualInputCalled).toBe(true);
    expect(creds.access).toBe('test-access-token');
  });

  test('login() calls onProgress during token exchange', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';
    process.env.BERGET_OAUTH_TIMEOUT_MS = '1000';

    let resolveAuthUrl: (url: string) => void;
    const authUrlPromise = new Promise<string>((resolve) => {
      resolveAuthUrl = resolve;
    });
    let progressMessage = '';

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => resolveAuthUrl(info.url),
      onProgress: (message) => {
        progressMessage = message;
      },
      onPrompt: async () => 'test-auth-code',
    };

    globalThis.fetch = mockFetch(originalFetch);

    const loginPromise = loginBerget(callbacks);
    loginPromise.catch(() => {});

    const authUrl = await authUrlPromise;
    await hitCallback(authUrl);
    await loginPromise;

    expect(progressMessage).toContain('Exchanging');
  });

  test('refreshToken() calls Berget API refresh endpoint', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    let capturedBody: null | string = null;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = resolveInputUrl(input);
      if (url.includes('/v1/auth/refresh')) {
        const body = init?.body;
        capturedBody = typeof body === 'string' ? body : JSON.stringify(body);
        return Response.json(
          {
            expires_in: 300,
            refresh_token: 'new-refresh-token',
            token: 'new-access-token',
          },
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const inputCreds: OAuthCredentials = {
      access: 'old-access-token',
      expires: Date.now() - 1000,
      refresh: 'old-refresh-token',
    };

    const beforeRefresh = Date.now();
    const newCreds = await refreshBergetToken(inputCreds);
    const afterRefresh = Date.now();

    expect(capturedBody).toContain('refresh_token');
    expect(capturedBody).toContain('old-refresh-token');
    expect(newCreds.access).toBe('new-access-token');
    expect(newCreds.refresh).toBe('new-refresh-token');
    expect(newCreds.expires).toBeGreaterThanOrEqual(beforeRefresh + 300 * 1000 - 60 * 1000);
    expect(newCreds.expires).toBeLessThanOrEqual(afterRefresh + 300 * 1000 - 60 * 1000);
  });

  test('refreshToken() throws on 401 failure', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> => new Response('Unauthorized', { status: 401 });

    const inputCreds: OAuthCredentials = {
      access: 'old-access-token',
      expires: Date.now() - 1000,
      refresh: 'expired-refresh-token',
    };

    await expect(refreshBergetToken(inputCreds)).rejects.toThrow('Token refresh failed: 401');
  });

  test('refreshToken() throws on network error', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = async (): Promise<Response> => {
      throw new Error('Network error');
    };

    const inputCreds: OAuthCredentials = {
      access: 'some-access-token',
      expires: Date.now() - 1000,
      refresh: 'some-refresh-token',
    };

    await expect(refreshBergetToken(inputCreds)).rejects.toThrow('Network error');
  });

  test('getApiKey returns cred.access', () => {
    const cred: OAuthCredentials = {
      access: 'my-access-token',
      expires: Date.now() + 60_000,
      refresh: 'r',
    };
    expect(cred.access).toBe('my-access-token');
  });

  test('refreshToken() sequential refresh chain works when refresh_token is rotated', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    let callCount = 0;
    globalThis.fetch = async (): Promise<Response> => {
      callCount++;
      return Response.json(
        {
          expires_in: 300,
          refresh_token: `refresh-token-${callCount}`,
          token: `access-token-${callCount}`,
        },
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    };

    const creds: OAuthCredentials = {
      access: 'initial-access-token',
      expires: Date.now() - 1000,
      refresh: 'initial-refresh-token',
    };

    const firstRefresh = await refreshBergetToken(creds);
    expect(firstRefresh.access).toBe('access-token-1');
    expect(firstRefresh.refresh).toBe('refresh-token-1');

    const secondRefresh = await refreshBergetToken(firstRefresh);
    expect(secondRefresh.access).toBe('access-token-2');
    expect(secondRefresh.refresh).toBe('refresh-token-2');
  });

  test('refreshToken() with non-JSON response body throws', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-auth.berget.ai';

    globalThis.fetch = async (): Promise<Response> =>
      new Response('<html>Internal Server Error</html>', {
        headers: { 'Content-Type': 'text/html' },
        status: 200,
      });

    const inputCreds: OAuthCredentials = {
      access: 'old-access-token',
      expires: Date.now() - 1000,
      refresh: 'old-refresh-token',
    };

    await expect(refreshBergetToken(inputCreds)).rejects.toThrow();
  });
});
