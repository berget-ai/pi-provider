import type { OAuthCredential } from '@earendil-works/pi-ai';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { parseRetryAfterMs, refreshBergetToken, resolveInputUrl } from '../index';

const EXPIRY_BUFFER_MS = 60 * 1000;

const bergetRefreshResponse = (
  token: string,
  refresh: string,
  expiresIn: number,
  status = 200,
): Response => {
  return Response.json(
    { expires_in: expiresIn, refresh_token: refresh, token },
    {
      headers: { 'Content-Type': 'application/json' },
      status,
    },
  );
};

function expiredCreds(refresh = 'initial-refresh-token'): OAuthCredential {
  return {
    access: 'old-access-token',
    expires: Date.now() - 1000,
    refresh,
    type: 'oauth',
  };
}

function isBergetRefreshUrl(url: string): boolean {
  return url.includes('/v1/auth/refresh');
}

const rateLimitResponse = (retryAfter?: string): Response =>
  Response.json(
    {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts, please try again later',
        type: 'rate_limit_exceeded',
      },
    },
    {
      headers: retryAfter ? { 'Retry-After': retryAfter } : {},
      status: 429,
    },
  );

function parseRefreshBody(init?: RequestInit): { refresh_token: string } {
  const body = init?.body;
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const parsed = JSON.parse(bodyString) as Record<string, unknown>;
  return {
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
  };
}

describe('Token Refresh Flow - Berget API', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  });

  test('refresh sends refresh_token to Berget API endpoint', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = resolveInputUrl(input);
      capturedInit = init;
      return Promise.resolve(bergetRefreshResponse('new-access', 'new-refresh', 300));
    };

    await refreshBergetToken(expiredCreds('my-refresh-token'));

    expect(capturedUrl).toContain('test-api.berget.ai/v1/auth/refresh');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = parseRefreshBody(capturedInit);
    expect(body.refresh_token).toBe('my-refresh-token');
  });

  test('refresh returns new access token, rotated refresh token, and correct expires', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(bergetRefreshResponse('access-1', 'rotated-1', 300));

    const beforeRefresh = Date.now();
    const result = await refreshBergetToken(expiredCreds('old-refresh'));
    const afterRefresh = Date.now();

    expect(result.access).toBe('access-1');
    expect(result.refresh).toBe('rotated-1');
    expect(result.expires).toBeGreaterThanOrEqual(beforeRefresh + 300 * 1000 - EXPIRY_BUFFER_MS);
    expect(result.expires).toBeLessThanOrEqual(afterRefresh + 300 * 1000 - EXPIRY_BUFFER_MS);
  });

  test('full lifecycle: login → access expires → refresh → access expires → refresh again', async () => {
    let callCount = 0;
    globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      return Promise.resolve(
        bergetRefreshResponse(`access-${String(callCount)}`, `rotated-${String(callCount)}`, 300),
      );
    };

    const creds = expiredCreds('login-refresh-token');

    const r1 = await refreshBergetToken(creds);
    expect(r1.access).toBe('access-1');
    expect(r1.refresh).toBe('rotated-1');

    const r2 = await refreshBergetToken(r1);
    expect(r2.access).toBe('access-2');
    expect(r2.refresh).toBe('rotated-2');

    const r3 = await refreshBergetToken(r2);
    expect(r3.access).toBe('access-3');
    expect(r3.refresh).toBe('rotated-3');
  });

  test('each refresh sends the previous rotated refresh_token', async () => {
    const capturedTokens: string[] = [];
    let callCount = 0;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      const body = parseRefreshBody(init);
      capturedTokens.push(body.refresh_token);
      return Promise.resolve(
        bergetRefreshResponse(`access-${String(callCount)}`, `rotated-${String(callCount)}`, 300),
      );
    };

    const creds = expiredCreds('login-refresh-token');

    const r1 = await refreshBergetToken(creds);
    const r2 = await refreshBergetToken(r1);
    const r3 = await refreshBergetToken(r2);

    expect(capturedTokens).toEqual(['login-refresh-token', 'rotated-1', 'rotated-2']);
    expect(r3.access).toBe('access-3');
  });

  test('refresh throws on 400 invalid_grant from Berget API', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          { error: 'invalid_grant', error_description: 'Invalid refresh token' },
          { headers: { 'Content-Type': 'application/json' }, status: 400 },
        ),
      );

    await expect(refreshBergetToken(expiredCreds('stale-token'))).rejects.toThrow(
      'Token refresh failed: 400',
    );
  });

  test('retries on 429 rate limit and succeeds once the limiter clears', async () => {
    let callCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      if (callCount <= 2) return Promise.resolve(rateLimitResponse('0'));
      return Promise.resolve(bergetRefreshResponse('access-after-retry', 'rotated', 300));
    };

    const result = await refreshBergetToken(expiredCreds('token'));

    expect(callCount).toBe(3);
    expect(result.access).toBe('access-after-retry');
  });

  test('throws after exhausting retries on persistent 429', async () => {
    let callCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      return Promise.resolve(rateLimitResponse('0'));
    };

    await expect(refreshBergetToken(expiredCreds('token'))).rejects.toThrow(
      'Token refresh failed: 429',
    );
    expect(callCount).toBe(3);
  });

  test('fails fast when Retry-After exceeds the cap (long rate-limit window)', async () => {
    let callCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      // The auth rate limiter asks for the full 30-minute window.
      return Promise.resolve(rateLimitResponse('1800'));
    };

    await expect(refreshBergetToken(expiredCreds('token'))).rejects.toThrow(
      'Token refresh failed: 429',
    );
    expect(callCount).toBe(1);
  });

  test('retries on 5xx server errors, does not retry other 4xx', async () => {
    let callCount = 0;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      return Promise.resolve(new Response('Bad Gateway', { status: 502 }));
    };

    await expect(refreshBergetToken(expiredCreds('token'))).rejects.toThrow(
      'Token refresh failed: 502',
    );
    expect(callCount).toBe(3);

    callCount = 0;
    globalThis.fetch = (): Promise<Response> => {
      callCount++;
      return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    };

    await expect(refreshBergetToken(expiredCreds('token'))).rejects.toThrow(
      'Token refresh failed: 400',
    );
    expect(callCount).toBe(1);
  });

  test('aborts between retries when the signal fires', async () => {
    let callCount = 0;
    const controller = new AbortController();
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }
      callCount++;
      controller.abort();
      return Promise.resolve(rateLimitResponse('30'));
    };

    await expect(refreshBergetToken(expiredCreds('token'), controller.signal)).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  test('refresh throws on 401 from Berget API', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response('Unauthorized', { status: 401 }));

    await expect(refreshBergetToken(expiredCreds('expired-token'))).rejects.toThrow(
      'Token refresh failed: 401',
    );
  });

  test('concurrent refreshes with same credentials → second fails after Berget invalidates token', async () => {
    let callCount = 0;
    const inflightResolvers: Array<() => void> = [];

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return new Response('Not found', { status: 404 });
      }

      callCount++;
      const myCallIndex = callCount;

      if (myCallIndex === 1) {
        await new Promise<void>((resolve) => {
          inflightResolvers.push(resolve);
        });
        return bergetRefreshResponse('access-1', 'rotated-1', 300);
      }

      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    };

    const creds = expiredCreds('initial-refresh-token');

    const firstPromise = refreshBergetToken(creds);
    const secondPromise = refreshBergetToken(creds);

    for (const r of inflightResolvers) r();

    const firstResult = await firstPromise;
    expect(firstResult.refresh).toBe('rotated-1');

    await expect(secondPromise).rejects.toThrow('Token refresh failed');
  });

  test('refresh with short expires_in from Berget API', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(bergetRefreshResponse('access-1', 'rotated-1', 60));

    const result = await refreshBergetToken(expiredCreds('old-token'));

    expect(result.access).toBe('access-1');
    expect(result.refresh).toBe('rotated-1');
    expect(result.expires).toBeLessThanOrEqual(Date.now() + 60 * 1000 - EXPIRY_BUFFER_MS + 100);
  });

  test('refresh uses BERGET_API_URL env var', async () => {
    process.env.BERGET_API_URL = 'https://custom-api.example.com';
    let capturedUrl: string | undefined;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = resolveInputUrl(input);
      return Promise.resolve(bergetRefreshResponse('access', 'refresh', 300));
    };

    await refreshBergetToken(expiredCreds('token'));
    expect(capturedUrl).toContain('custom-api.example.com/v1/auth/refresh');
  });

  describe('parseRetryAfterMs', () => {
    test('parses delay-seconds', () => {
      expect(parseRetryAfterMs('0')).toBe(0);
      expect(parseRetryAfterMs('30')).toBe(30_000);
    });

    test('parses HTTP-date relative to now', () => {
      const date = new Date(Date.now() + 5000).toUTCString();
      const ms = parseRetryAfterMs(date);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(5000);
    });

    test('clamps past HTTP-dates to zero', () => {
      expect(parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString())).toBe(0);
    });

    test('returns undefined for missing or invalid headers', () => {
      expect(parseRetryAfterMs(null)).toBeUndefined();
      expect(parseRetryAfterMs('')).toBeUndefined();
      expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
    });
  });

  test('Berget refresh token rotation: each refresh returns a new refresh_token that works on next call', async () => {
    const validTokens = new Set(['initial-refresh-token']);
    let callCount = 0;

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!isBergetRefreshUrl(resolveInputUrl(input))) {
        return Promise.resolve(new Response('Not found', { status: 404 }));
      }

      callCount++;
      const body = parseRefreshBody(init);

      if (!validTokens.has(body.refresh_token)) {
        return Promise.resolve(
          Response.json(
            { error: 'invalid_grant', error_description: 'Token not found' },
            { status: 400 },
          ),
        );
      }

      validTokens.delete(body.refresh_token);
      const newToken = `rotated-${String(callCount)}`;
      validTokens.add(newToken);

      return Promise.resolve(bergetRefreshResponse(`access-${String(callCount)}`, newToken, 300));
    };

    const creds = expiredCreds('initial-refresh-token');

    const r1 = await refreshBergetToken(creds);
    expect(r1.access).toBe('access-1');
    expect(r1.refresh).toBe('rotated-1');

    const r2 = await refreshBergetToken(r1);
    expect(r2.access).toBe('access-2');
    expect(r2.refresh).toBe('rotated-2');

    const r3 = await refreshBergetToken(r2);
    expect(r3.access).toBe('access-3');
    expect(r3.refresh).toBe('rotated-3');

    await expect(refreshBergetToken(r1)).rejects.toThrow('Token refresh failed');
  });
});
