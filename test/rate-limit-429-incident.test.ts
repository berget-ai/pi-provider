/**
 * Regression suite replicating the OAuth-refresh 429 rate-limit incident.
 *
 * Two layers of coverage:
 *
 * 1. **Client integration** — the real `refreshBergetToken` driven through the
 *    real pi-ai auth-resolution path (`createModels` + `InMemoryCredentialStore`
 *    + `createProvider`), so a regression in either pi-provider's retry policy
 *    or pi-ai's `ModelsError` wrapping is caught here.
 *
 * 2. **Re-implemented simulations** — the gateway's `authRateLimit` bucket and
 *    pi-ai 0.83.0's `expiresSoon` predicate are re-implemented from the report
 *    (§2 facts table, §10.1 source excerpt) because they live in other repos /
 *    other package versions. These document the causal chain; if the real
 *    implementations change, update the replicas to match.
 */
import {
  InMemoryCredentialStore,
  createModels,
  createProvider,
  isRetryableAssistantError,
  type AssistantMessage,
  type Model,
  type OAuthCredential,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { refreshBergetToken, resolveInputUrl } from '../index';

// === Report constants (§2 facts table) ===

/** Keycloak access-token lifetime — Keycloak default, no realm override (§11.1). */
const KEYCLOAK_TOKEN_LIFETIME_S = 300;
/** pi-provider expiry buffer subtracted from stored expiry (`index.ts`). */
const EXPIRY_BUFFER_MS = 60 * 1000;
/** Gateway `authRateLimit` budget: 20 requests per 30-minute window (§2). */
const AUTH_RATE_LIMIT_MAX = 20;
/** Static `Retry-After` the gateway auth limiter always sends (§2, §11.8). */
const AUTH_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;
/** pi-ai 0.83.0 pre-expiry refresh threshold (§10.1). */
const PI_AI_083_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
/** Pi core's outer retry backoff: 2 s × 2^n, maxRetries = 3 (§11.3). */
const OUTER_RETRY_DELAYS_MS = [2000, 4000, 8000];

const GATEWAY_429_BODY = {
  error: {
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many authentication attempts, please try again later',
    type: 'rate_limit_exceeded',
  },
};

// === Gateway authRateLimit replica ===
// Re-implemented from §2: fixed 30-minute window of 20 requests per key, 429
// with the static-window Retry-After once exhausted. If
// `api/src/middleware/rate-limit.middleware.ts` changes, update this replica.

class AuthRateLimiterReplica {
  private readonly windowStart = Date.now();
  private count = 0;

  request(): Response {
    if (this.count >= AUTH_RATE_LIMIT_MAX) {
      return Response.json(GATEWAY_429_BODY, {
        headers: { 'Retry-After': String(AUTH_RATE_LIMIT_WINDOW_MS / 1000) },
        status: 429,
      });
    }
    this.count++;
    return Response.json(
      {
        expires_in: KEYCLOAK_TOKEN_LIFETIME_S,
        refresh_token: `rotated-${String(this.count)}`,
        token: `access-${String(this.count)}`,
      },
      { headers: { 'Content-Type': 'application/json' }, status: 200 },
    );
  }

  get requestCount(): number {
    return this.count;
  }

  get windowExpired(): boolean {
    return Date.now() - this.windowStart >= AUTH_RATE_LIMIT_WINDOW_MS;
  }
}

// === pi-ai 0.83.0 expiresSoon replica (§10.1) ===
// Re-implemented from the 0.83.0 source excerpt in the report; the installed
// devDependency (0.81.1) predates the threshold, so it cannot be imported.
// If `pi-ai/dist/auth/resolve.js` changes, update this replica.

function expiresSoonReplica(credential: OAuthCredential, minOAuthValidityMs?: number): boolean {
  const minimumValidityMs = Math.max(PI_AI_083_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
  return Date.now() + minimumValidityMs >= credential.expires;
}

// === Helpers ===

function storedBergetCredential(): OAuthCredential {
  // A credential as pi-provider stores it after a successful login/refresh:
  // 240 s of effective validity from a 300 s token (§11.6).
  return {
    access: 'current-access-token',
    expires: Date.now() + KEYCLOAK_TOKEN_LIFETIME_S * 1000 - EXPIRY_BUFFER_MS,
    refresh: 'current-refresh-token',
    type: 'oauth',
  };
}

function testModel(): Model<'openai-completions'> {
  return {
    api: 'openai-completions',
    baseUrl: 'https://test-api.berget.ai/v1',
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'moonshotai/Kimi-K3',
    input: ['text'],
    maxTokens: 16_384,
    name: 'moonshotai/Kimi-K3',
    provider: 'berget',
    reasoning: true,
  };
}

function installGatewayFetch(limiter: AuthRateLimiterReplica): () => number[] {
  const requestTimes: number[] = [];
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = resolveInputUrl(input);
    if (url.includes('/v1/auth/refresh')) {
      requestTimes.push(Date.now());
      return Promise.resolve(limiter.request());
    }
    return Promise.resolve(new Response('Not found', { status: 404 }));
  };
  return () => requestTimes;
}

/** Build the failed assistant turn Pi's retry classifier actually consumes. */
function errorTurn(errorMessage: string): AssistantMessage {
  return {
    api: 'openai-completions',
    content: [],
    errorMessage,
    model: 'moonshotai/Kimi-K3',
    provider: 'berget',
    role: 'assistant',
    stopReason: 'error',
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  };
}

function buildModels(): ReturnType<typeof createModels> & {
  credentials: InMemoryCredentialStore;
} {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(
    createProvider({
      api: openAICompletionsApi(),
      auth: {
        oauth: {
          login: () => Promise.reject(new Error('login not used in this suite')),
          name: 'Berget AI',
          refresh: (credential: OAuthCredential, signal?: AbortSignal) =>
            refreshBergetToken(credential, signal),
          toAuth: (credential: OAuthCredential) => Promise.resolve({ apiKey: credential.access }),
        },
      },
      baseUrl: 'https://test-api.berget.ai/v1',
      id: 'berget',
      models: [testModel()],
      name: 'Berget AI',
    }),
  );
  return Object.assign(models, { credentials });
}

describe('OAuth refresh 429 rate-limit incident', () => {
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
    vi.useRealTimers();
  });

  describe("the 429 error body matches pi-ai's retryable classifier (§11.3)", () => {
    test('the user-facing error message is classified retryable by the installed pi-ai', () => {
      // The exact message pi-ai surfaces: resolve.js wraps the provider error
      // as `OAuth refresh failed for <id>`, and the report quotes the cause.
      const message = `OAuth refresh failed for berget: Token refresh failed: 429 ${JSON.stringify(GATEWAY_429_BODY)}`;

      expect(isRetryableAssistantError(errorTurn(message))).toBe(true);
    });

    test('rate_limit_exceeded is not in the non-retryable quota/billing set', () => {
      // §11.3: the one signal that should say "hard limit, stop" never reaches
      // the non-retryable classifier, so Pi's outer retry always amplifies.
      const quotaStyleMessage = 'insufficient_quota: billing limit reached';
      expect(isRetryableAssistantError(errorTurn(quotaStyleMessage))).toBe(false);
    });
  });

  describe('the §3 incident timeline, replicated through real pi-ai auth resolution', () => {
    test('an expired credential against an exhausted bucket produces the 4-attempt 429 sequence', async () => {
      vi.useFakeTimers();
      const limiter = new AuthRateLimiterReplica();
      // Burn the 20-request budget with legitimate background refreshes first.
      for (let index = 0; index < AUTH_RATE_LIMIT_MAX; index++) {
        limiter.request();
      }
      const getRequestTimes = installGatewayFetch(limiter);

      const models = buildModels();
      const expired: OAuthCredential = {
        access: 'dead-access-token',
        expires: Date.now() - 1000,
        refresh: 'refresh-token',
        type: 'oauth',
      };
      await models.credentials.modify('berget', () => Promise.resolve(expired));

      const start = Date.now();
      const attemptTimes: number[] = [];

      // Pi core retries the surfaced error at 2 s / 4 s / 8 s (§3, §11.3),
      // each retry re-entering resolveProviderAuth and re-issuing a refresh.
      let lastError: unknown;
      for (let outerAttempt = 0; outerAttempt <= OUTER_RETRY_DELAYS_MS.length; outerAttempt++) {
        try {
          attemptTimes.push(Date.now() - start);
          await models.getAuth('berget');
        } catch (error) {
          lastError = error;
        }
        if (outerAttempt < OUTER_RETRY_DELAYS_MS.length) {
          await vi.advanceTimersByTimeAsync(OUTER_RETRY_DELAYS_MS[outerAttempt]);
        }
      }

      // The wrapped error is the user-facing message from the report.
      expect(lastError).toBeInstanceOf(Error);
      const message = (lastError as Error).message;
      expect(message).toContain('OAuth refresh failed for berget');
      expect((lastError as Error).cause).toBeInstanceOf(Error);
      expect(((lastError as Error).cause as Error).message).toContain('Token refresh failed: 429');
      expect(((lastError as Error).cause as Error).message).toContain('rate_limit_exceeded');

      // 4 outer attempts, each burning limiter requests but never waiting out
      // the 30-minute window — zero successful refreshes, zero inference tokens.
      expect(attemptTimes).toHaveLength(4);
      expect(attemptTimes[1] - attemptTimes[0]).toBe(2000);
      expect(attemptTimes[2] - attemptTimes[1]).toBe(4000);
      expect(attemptTimes[3] - attemptTimes[2]).toBe(8000);
      expect(getRequestTimes().length).toBeGreaterThanOrEqual(4);
      expect(limiter.windowExpired).toBe(false);
    });

    test('without the bounded-retry fix the failure would be identical on attempt 1 (pre-0.3.1 behaviour)', async () => {
      // Guards the fix's contract: with the gateway's static 30-minute
      // Retry-After, refreshBergetToken must fail fast (single fetch) rather
      // than hang the agent or burn retries against a window that cannot clear.
      const limiter = new AuthRateLimiterReplica();
      for (let index = 0; index < AUTH_RATE_LIMIT_MAX; index++) {
        limiter.request();
      }
      const getRequestTimes = installGatewayFetch(limiter);

      await expect(
        refreshBergetToken({
          access: 'dead',
          expires: Date.now() - 1000,
          refresh: 'refresh-token',
          type: 'oauth',
        }),
      ).rejects.toThrow('Token refresh failed: 429');

      expect(getRequestTimes()).toHaveLength(1);
    });
  });

  describe('the hot refresh loop (§10, pi-ai ≥ 0.83.0)', () => {
    test('a freshly stored credential is immediately "expiring soon" under the 0.83.0 threshold', () => {
      // §11.6: 240 s stored validity < 300 s threshold ⇒ refresh on every
      // agent request. This predicate is the loop's trigger.
      expect(expiresSoonReplica(storedBergetCredential())).toBe(true);
    });

    test('one refresh per agent request exhausts the 20/30-min bucket in a single session', () => {
      const limiter = new AuthRateLimiterReplica();
      const credential = storedBergetCredential();

      let requestsUntilExhausted = 0;
      for (let turn = 0; turn < AUTH_RATE_LIMIT_MAX + 5; turn++) {
        if (!expiresSoonReplica(credential)) break;
        const response = limiter.request();
        if (response.status === 429) break;
        requestsUntilExhausted++;
        // A refresh changes nothing: the rotated credential is stored with
        // the same 240 s validity, so the loop re-arms immediately (§10.2).
      }

      expect(requestsUntilExhausted).toBe(AUTH_RATE_LIMIT_MAX);
      expect(limiter.request().status).toBe(429);
    });

    test('raising the Keycloak lifespan ≥ 420 s breaks the loop (§8.3 fix)', () => {
      // With expires_in = 900 s the stored validity (840 s) exceeds the 300 s
      // threshold, restoring a normal ~14-minute cadence.
      const raisedLifespanCredential: OAuthCredential = {
        ...storedBergetCredential(),
        expires: Date.now() + 900 * 1000 - EXPIRY_BUFFER_MS,
      };
      expect(expiresSoonReplica(raisedLifespanCredential)).toBe(false);
    });

    test('Math.max semantics: a provider override can only raise the floor, never lower it (§10.4-b)', () => {
      const credential = storedBergetCredential();
      // pi-provider cannot pass minOAuthValidityMs to opt down below 5 min.
      expect(expiresSoonReplica(credential, 60 * 1000)).toBe(true);
    });
  });

  describe('the refresh-token death path is a clean 401, not a 429 (§11.2)', () => {
    test('an invalid refresh token fails immediately without retries', async () => {
      const getRequestTimes = (() => {
        const times: number[] = [];
        globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
          if (resolveInputUrl(input).includes('/v1/auth/refresh')) {
            times.push(Date.now());
            return Promise.resolve(
              Response.json(
                {
                  error: {
                    code: 'INVALID_REFRESH_TOKEN',
                    message: 'Invalid or expired refresh token',
                    type: 'authentication_error',
                  },
                },
                { status: 401 },
              ),
            );
          }
          return Promise.resolve(new Response('Not found', { status: 404 }));
        };
        return () => times;
      })();

      const models = buildModels();
      await models.credentials.modify('berget', () =>
        Promise.resolve({
          access: 'dead-access-token',
          expires: Date.now() - 1000,
          refresh: 'expired-refresh-token',
          type: 'oauth',
        }),
      );

      await expect(models.getAuth('berget')).rejects.toThrow('OAuth refresh failed for berget');
      // Non-retryable 4xx: exactly one fetch, no limiter tokens burned.
      expect(getRequestTimes()).toHaveLength(1);
    });
  });
});
