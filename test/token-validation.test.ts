import type { OAuthCredentials } from '@earendil-works/pi-ai';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { exchangeToken, refreshBergetToken } from '../index';

describe('Token JSON shape validation', () => {
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

  test('exchangeToken throws when Keycloak response is missing access_token', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ expires_in: 300, refresh_token: 'ok' }, { status: 200 }));

    await expect(exchangeToken('code', 'verifier')).rejects.toThrow(
      'Invalid token response: expected { access_token: string, expires_in: number, refresh_token: string }',
    );
  });

  test('exchangeToken throws when Keycloak response is missing expires_in', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ access_token: 'ok', refresh_token: 'ok' }, { status: 200 }));

    await expect(exchangeToken('code', 'verifier')).rejects.toThrow(
      'Invalid token response: expected { access_token: string, expires_in: number, refresh_token: string }',
    );
  });

  test('exchangeToken throws when Keycloak response is missing refresh_token', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ access_token: 'ok', expires_in: 300 }, { status: 200 }));

    await expect(exchangeToken('code', 'verifier')).rejects.toThrow(
      'Invalid token response: expected { access_token: string, expires_in: number, refresh_token: string }',
    );
  });

  test('exchangeToken succeeds with valid Keycloak response', async () => {
    process.env.BERGET_AUTH_URL = 'https://test-login.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          { access_token: 'access', expires_in: 300, refresh_token: 'refresh' },
          { status: 200 },
        ),
      );

    const creds = await exchangeToken('code', 'verifier');
    expect(creds.access).toBe('access');
    expect(creds.refresh).toBe('refresh');
  });

  test('refreshBergetToken throws when Berget response is missing token', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(Response.json({ expires_in: 300, refresh_token: 'ok' }, { status: 200 }));

    const credentials: OAuthCredentials = {
      access: 'old',
      expires: Date.now() - 1000,
      refresh: 'refresh',
    };

    await expect(refreshBergetToken(credentials)).rejects.toThrow(
      'Invalid token response: expected { token: string, expires_in: number, refresh_token?: string }',
    );
  });

  test('refreshBergetToken succeeds with valid Berget response', async () => {
    process.env.BERGET_API_URL = 'https://test-api.berget.ai';

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        Response.json({ expires_in: 300, refresh_token: 'rotated', token: 'new' }, { status: 200 }),
      );

    const credentials: OAuthCredentials = {
      access: 'old',
      expires: Date.now() - 1000,
      refresh: 'refresh',
    };

    const result = await refreshBergetToken(credentials);
    expect(result.access).toBe('new');
    expect(result.refresh).toBe('rotated');
  });
});
