/**
 * LIVE test against the production API (`https://api.berget.ai`) that
 * demonstrates the server-side half of the OAuth-refresh 429 rate-limit
 * incident — without pi-provider code.
 *
 * What it proves, against the real deployment:
 *
 * 1. `POST /v1/auth/refresh` is behind the brute-force auth rate limiter
 *    (20 req / 30 min per IP+user-agent): the first 20 invalid-refresh
 *    requests pass the limiter and fail at Keycloak with 401
 *    `INVALID_REFRESH_TOKEN`; the 21st never reaches the handler — 429
 *    `RATE_LIMIT_EXCEEDED` (§2, §7).
 * 2. The 429 carries the STATIC `Retry-After: 1800` header regardless of the
 *    real Redis TTL (§11.8).
 * 3. The bucket is SHARED with `/v1/auth/login`: once refreshes exhaust it,
 *    logins are rejected too — this is why "re-login doesn't help" (§5, §7).
 * 4. The key is per IP+user-agent: a different user-agent gets a fresh bucket
 *    (which is also why NAT-sharing exhausts it for strangers, §7).
 * 5. Inference with an API key is unaffected throughout — the failure is
 *    specific to the auth limiter ("0 inference tokens consumed", §3).
 *
 * Rate-limiter safety: the limiter keys on the first 20 chars of the
 * user-agent, so this test sends a random `rl-probe-<12 chars>` user-agent —
 * every run gets its own fresh bucket and never consumes the budget shared by
 * real users or Pi agents from the same IP.
 *
 * This test is OPT-IN because it talks to production:
 *
 *   BERGET_LIVE_API_TEST=1 npx vitest run test/live-api-rate-limit.test.ts
 *
 * It reads the API key from `~/.secrets/berget-api-key` (inference control
 * only; the refresh path itself is unauthenticated).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

const API_BASE_URL = process.env.BERGET_LIVE_API_URL || 'https://api.berget.ai';

// Facts from api/src/middleware/rate-limit.middleware.ts (verified against the
// deployed image, report §2/§9).
const AUTH_RATE_LIMIT_MAX = 20;
const STATIC_RETRY_AFTER_SECONDS = '1800';

const randomUserAgent = (): string =>
  // Key is userAgent.slice(0, 20): `rl-probe-` is 9 chars + 11 random hex = 20.
  `rl-probe-${randomBytes(6).toString('hex').slice(0, 11)}`;

function readApiKey(): string {
  const keyPath = path.join(homedir(), '.secrets', 'berget-api-key');
  const key = readFileSync(keyPath, 'utf8').trim();
  if (!key) throw new Error(`API key file is empty: ${keyPath}`);
  return key;
}

interface RefreshOutcome {
  status: number;
  body?: unknown;
  retryAfter?: null | string;
}

const RUN_LIVE = process.env.BERGET_LIVE_API_TEST === '1';

describe.skipIf(!RUN_LIVE)('LIVE: production auth rate limiter on /v1/auth/refresh', () => {
  let apiKey: string;
  // User-agent A exhausts its bucket; user-agent B is the isolation control.
  let userAgentA: string;
  let refreshOutcomes: RefreshOutcome[];
  let sharedBucketLoginStatus: number;
  let isolationRefreshStatus: number;
  let inferenceStatusBefore: number;
  let inferenceStatusAfter: number;

  const getModelsWithApiKey = async (): Promise<number> => {
    const response = await fetch(`${API_BASE_URL}/v1/models/chat`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // Drain the body so the connection can be reused/closed cleanly.
    await response.text();
    return response.status;
  };

  const postRefresh = async (userAgent: string): Promise<RefreshOutcome> => {
    const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      body: JSON.stringify({ refresh_token: 'live-test-invalid-token' }),
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
      method: 'POST',
    });
    const body: unknown = await response.json().catch(() => {});
    return {
      body,
      retryAfter: response.headers.get('Retry-After'),
      status: response.status,
    };
  };

  beforeAll(async () => {
    apiKey = readApiKey();
    userAgentA = randomUserAgent();

    // Control: the API key works before we touch the limiter.
    inferenceStatusBefore = await getModelsWithApiKey();

    // Hammer the refresh endpoint: MAX requests should pass the limiter and
    // fail at Keycloak; request MAX+1 should trip it. Sequential, so the
    // transition point is deterministic.
    refreshOutcomes = [];
    for (let index = 0; index < AUTH_RATE_LIMIT_MAX + 1; index++) {
      refreshOutcomes.push(await postRefresh(userAgentA));
    }

    // Shared bucket: a login attempt with the same user-agent.
    const loginResponse = await fetch(`${API_BASE_URL}/v1/auth/login`, {
      headers: { 'User-Agent': userAgentA },
      redirect: 'manual',
    });
    await loginResponse.text();
    sharedBucketLoginStatus = loginResponse.status;

    // Isolation: same IP, different user-agent → fresh bucket.
    const isolationOutcome = await postRefresh(randomUserAgent());
    isolationRefreshStatus = isolationOutcome.status;

    // Control: inference still works after the bucket is exhausted.
    inferenceStatusAfter = await getModelsWithApiKey();
  }, 120_000);

  test('the first 20 refreshes pass the limiter and fail at Keycloak with 401 INVALID_REFRESH_TOKEN', () => {
    const underLimit = refreshOutcomes.slice(0, AUTH_RATE_LIMIT_MAX);
    expect(underLimit.map((outcome) => outcome.status)).toEqual(
      Array.from({ length: AUTH_RATE_LIMIT_MAX }, () => 401),
    );
    // The body also carries request_id/trace_id envelope fields (added after
    // the report's §11.2 probe); assert the error object itself exactly.
    expect(underLimit[0].body).toMatchObject({
      error: {
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid or expired refresh token',
        type: 'authentication_error',
      },
    });
  });

  test('the 21st refresh is rejected by the limiter: 429 RATE_LIMIT_EXCEEDED', () => {
    const overLimit = refreshOutcomes[AUTH_RATE_LIMIT_MAX];
    expect(overLimit.status).toBe(429);
    expect(overLimit.body).toEqual({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts, please try again later',
        type: 'rate_limit_exceeded',
      },
    });
  });

  test('the 429 carries the static Retry-After: 1800, not the real window TTL (§11.8)', () => {
    const overLimit = refreshOutcomes[AUTH_RATE_LIMIT_MAX];
    expect(overLimit.retryAfter).toBe(STATIC_RETRY_AFTER_SECONDS);
  });

  test('the exhausted bucket also rejects logins with the same identity (shared limiter, §7)', () => {
    // A healthy bucket would redirect to Keycloak (302). Once exhausted, the
    // same 20/30-min budget guards login/register/callback AND refresh.
    expect(sharedBucketLoginStatus).toBe(429);
  });

  test('a different user-agent from the same IP gets a fresh bucket (per IP+UA keying)', () => {
    expect(isolationRefreshStatus).toBe(401);
  });

  test('API-key inference is unaffected before and after the auth lockout (§3: zero tokens consumed)', () => {
    expect(inferenceStatusBefore).toBe(200);
    expect(inferenceStatusAfter).toBe(200);
  });
});
