import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  extractDeviceTokenResult,
  handleDevicePollError,
  loginBergetDeviceFlow,
  resolveInputUrl,
} from '../index';

const DEVICE_RESPONSE = {
  device_code: 'secret-device-code',
  expires_in: 600,
  interval: 0,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.berget.ai/realms/berget/device',
  verification_uri_complete: 'https://auth.berget.ai/realms/berget/device?user_code=ABCD-EFGH',
};

function mockInteraction(events: AuthEvent[] = []): AuthInteraction & {
  notify: ReturnType<typeof vi.fn>;
} {
  return {
    notify: vi.fn((event: AuthEvent) => {
      events.push(event);
    }),
    prompt: vi.fn((_p: AuthPrompt) => Promise.resolve('')),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function mockDeviceFetch(
  onTokenPoll: (pollCount: number) => Response,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let tokenPolls = 0;
  return (input: RequestInfo | URL) => {
    const url = resolveInputUrl(input);
    if (url.includes('/auth/device')) {
      return Promise.resolve(jsonResponse(DEVICE_RESPONSE));
    }
    tokenPolls += 1;
    return Promise.resolve(onTokenPoll(tokenPolls));
  };
}

const SUCCESS_TOKENS = { access_token: 'a', expires_in: 300, refresh_token: 'r' };

describe('device flow', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('notifies a device_code event and returns credentials after approval', async () => {
    const events: AuthEvent[] = [];
    const interaction = mockInteraction(events);

    let tokenPolls = 0;
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = resolveInputUrl(input);
      if (url.includes('/auth/device')) {
        return Promise.resolve(jsonResponse(DEVICE_RESPONSE));
      }
      tokenPolls += 1;
      return Promise.resolve(
        jsonResponse({ access_token: 'access-token', expires_in: 300, refresh_token: 'r' }),
      );
    };

    const credential = await loginBergetDeviceFlow(interaction);

    expect(credential).toMatchObject({
      access: 'access-token',
      refresh: 'r',
      type: 'oauth',
    });
    expect(credential.expires).toBeGreaterThan(Date.now());
    expect(tokenPolls).toBe(1);

    const deviceEvent = events.find((e) => e.type === 'device_code');
    expect(deviceEvent).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: DEVICE_RESPONSE.verification_uri_complete,
    });
  });

  test('keeps polling through authorization_pending and slow_down', async () => {
    vi.useFakeTimers();
    try {
      const interaction = mockInteraction();
      let lastPolls = 0;
      globalThis.fetch = mockDeviceFetch((pollCount) => {
        lastPolls = pollCount;
        if (pollCount === 1) {
          return jsonResponse({ error: 'authorization_pending' }, 400);
        }
        if (pollCount === 2) {
          return jsonResponse({ error: 'slow_down' }, 400);
        }
        return jsonResponse(SUCCESS_TOKENS);
      });

      const loginPromise = loginBergetDeviceFlow(interaction);
      // slow_down bumps the 0s interval to 5s — advance past it.
      await vi.advanceTimersByTimeAsync(10_000);
      const credential = await loginPromise;

      expect(credential.type).toBe('oauth');
      expect(lastPolls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('treats non-JSON poll responses as retryable', async () => {
    const interaction = mockInteraction();
    let lastPolls = 0;
    globalThis.fetch = mockDeviceFetch((pollCount) => {
      lastPolls = pollCount;
      if (pollCount === 1) {
        return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      }
      return jsonResponse(SUCCESS_TOKENS);
    });

    const credential = await loginBergetDeviceFlow(interaction);
    expect(credential.type).toBe('oauth');
    expect(lastPolls).toBe(2);
  });

  test('throws a user-readable error on access_denied', async () => {
    const interaction = mockInteraction();
    globalThis.fetch = mockDeviceFetch(() => jsonResponse({ error: 'access_denied' }, 400));

    await expect(loginBergetDeviceFlow(interaction)).rejects.toThrow('denied');
  });

  test('throws when device authorization itself fails', async () => {
    const interaction = mockInteraction();
    globalThis.fetch = () => Promise.resolve(new Response('forbidden', { status: 403 }));

    await expect(loginBergetDeviceFlow(interaction)).rejects.toThrow('Failed to start device flow');
  });

  test('extractDeviceTokenResult only maps complete token responses', () => {
    expect(extractDeviceTokenResult({ error: 'authorization_pending' })).toBeUndefined();
    expect(extractDeviceTokenResult({ access_token: 'a', expires_in: 300 })).toBeUndefined();
    const result = extractDeviceTokenResult({
      access_token: 'a',
      expires_in: 300,
      refresh_token: 'r',
    });
    expect(result).toMatchObject({ access: 'a', refresh: 'r', type: 'oauth' });
  });

  test('handleDevicePollError maps RFC 8628 errors', () => {
    expect(handleDevicePollError({ error: 'authorization_pending' }, 5)).toEqual({});
    expect(handleDevicePollError({ error: 'slow_down' }, 5)).toEqual({ interval: 10 });
    expect(handleDevicePollError({ error: 'slow_down' }, 28)).toEqual({ interval: 30 });
    expect(() => handleDevicePollError({ error: 'expired_token' }, 5)).toThrow('expired');
    expect(() => handleDevicePollError({ error: 'access_denied' }, 5)).toThrow('denied');
    expect(() => handleDevicePollError({ error: 'server_error' }, 5)).toThrow(
      'Device flow failed: server_error',
    );
    expect(() =>
      handleDevicePollError({ error: 'server_error', error_description: 'boom' }, 5),
    ).toThrow('boom');
  });
});
