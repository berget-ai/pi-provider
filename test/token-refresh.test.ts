import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { refreshBergetToken } from "../index";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

const EXPIRY_BUFFER_MS = 60 * 1000;

function expiredCreds(refresh = "initial-refresh-token"): OAuthCredentials {
  return {
    refresh,
    access: "old-access-token",
    expires: Date.now() - 1000,
  };
}

function isBergetRefreshUrl(url: string): boolean {
  return url.includes("/v1/auth/refresh");
}

function parseRefreshBody(init?: RequestInit): { refresh_token: string } {
  const body = init?.body;
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const parsed = JSON.parse(bodyStr);
  return {
    refresh_token: parsed.refresh_token ?? "",
  };
}

function bergetRefreshResponse(
  token: string,
  refresh: string,
  expiresIn: number,
  status = 200
): Response {
  return new Response(JSON.stringify({ token, refresh_token: refresh, expires_in: expiresIn }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Token Refresh Flow - Berget API", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.BERGET_API_URL = "https://test-api.berget.ai";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test("refresh sends refresh_token to Berget API endpoint", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedInit = init;
      return bergetRefreshResponse("new-access", "new-refresh", 300);
    };

    await refreshBergetToken(expiredCreds("my-refresh-token"));

    expect(capturedUrl).toContain("test-api.berget.ai/v1/auth/refresh");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });

    const body = parseRefreshBody(capturedInit);
    expect(body.refresh_token).toBe("my-refresh-token");
  });

  test("refresh returns new access token, rotated refresh token, and correct expires", async () => {
    globalThis.fetch = async () => bergetRefreshResponse("access-1", "rotated-1", 300);

    const beforeRefresh = Date.now();
    const result = await refreshBergetToken(expiredCreds("old-refresh"));
    const afterRefresh = Date.now();

    expect(result.access).toBe("access-1");
    expect(result.refresh).toBe("rotated-1");
    expect(result.expires).toBeGreaterThanOrEqual(beforeRefresh + 300 * 1000 - EXPIRY_BUFFER_MS);
    expect(result.expires).toBeLessThanOrEqual(afterRefresh + 300 * 1000 - EXPIRY_BUFFER_MS);
  });

  test("full lifecycle: login → access expires → refresh → access expires → refresh again", async () => {
    let callCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (
        !isBergetRefreshUrl(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        )
      ) {
        return new Response("Not found", { status: 404 });
      }
      callCount++;
      return bergetRefreshResponse(`access-${callCount}`, `rotated-${callCount}`, 300);
    };

    const creds = expiredCreds("login-refresh-token");

    const r1 = await refreshBergetToken(creds);
    expect(r1.access).toBe("access-1");
    expect(r1.refresh).toBe("rotated-1");

    const r2 = await refreshBergetToken(r1);
    expect(r2.access).toBe("access-2");
    expect(r2.refresh).toBe("rotated-2");

    const r3 = await refreshBergetToken(r2);
    expect(r3.access).toBe("access-3");
    expect(r3.refresh).toBe("rotated-3");
  });

  test("each refresh sends the previous rotated refresh_token", async () => {
    const capturedTokens: string[] = [];
    let callCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        !isBergetRefreshUrl(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        )
      ) {
        return new Response("Not found", { status: 404 });
      }
      callCount++;
      const body = parseRefreshBody(init);
      capturedTokens.push(body.refresh_token);
      return bergetRefreshResponse(`access-${callCount}`, `rotated-${callCount}`, 300);
    };

    const creds = expiredCreds("login-refresh-token");

    const r1 = await refreshBergetToken(creds);
    const r2 = await refreshBergetToken(r1);
    const r3 = await refreshBergetToken(r2);

    expect(capturedTokens).toEqual(["login-refresh-token", "rotated-1", "rotated-2"]);
    expect(r3.access).toBe("access-3");
  });

  test("refresh throws on 400 invalid_grant from Berget API", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Invalid refresh token" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );

    await expect(refreshBergetToken(expiredCreds("stale-token"))).rejects.toThrow(
      "Token refresh failed: 400"
    );
  });

  test("refresh throws on 401 from Berget API", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });

    await expect(refreshBergetToken(expiredCreds("expired-token"))).rejects.toThrow(
      "Token refresh failed: 401"
    );
  });

  test("concurrent refreshes with same credentials → second fails after Berget invalidates token", async () => {
    let callCount = 0;
    const inflightResolvers: Array<(value: unknown) => void> = [];

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (
        !isBergetRefreshUrl(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        )
      ) {
        return new Response("Not found", { status: 404 });
      }

      callCount++;
      const myCallIndex = callCount;

      if (myCallIndex === 1) {
        await new Promise(resolve => {
          inflightResolvers.push(resolve);
        });
        return bergetRefreshResponse("access-1", "rotated-1", 300);
      }

      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };

    const creds = expiredCreds("initial-refresh-token");

    const firstPromise = refreshBergetToken(creds);
    const secondPromise = refreshBergetToken(creds);

    inflightResolvers.forEach(r => r(undefined));

    const firstResult = await firstPromise;
    expect(firstResult.refresh).toBe("rotated-1");

    await expect(secondPromise).rejects.toThrow("Token refresh failed");
  });

  test("refresh with short expires_in from Berget API", async () => {
    globalThis.fetch = async () => bergetRefreshResponse("access-1", "rotated-1", 60);

    const result = await refreshBergetToken(expiredCreds("old-token"));

    expect(result.access).toBe("access-1");
    expect(result.refresh).toBe("rotated-1");
    expect(result.expires).toBeLessThanOrEqual(Date.now() + 60 * 1000 - EXPIRY_BUFFER_MS + 100);
  });

  test("refresh uses BERGET_API_URL env var", async () => {
    process.env.BERGET_API_URL = "https://custom-api.example.com";
    let capturedUrl: string | undefined;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return bergetRefreshResponse("access", "refresh", 300);
    };

    await refreshBergetToken(expiredCreds("token"));
    expect(capturedUrl).toContain("custom-api.example.com/v1/auth/refresh");
  });

  test("Berget refresh token rotation: each refresh returns a new refresh_token that works on next call", async () => {
    const validTokens = new Set(["initial-refresh-token"]);
    let callCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        !isBergetRefreshUrl(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        )
      ) {
        return new Response("Not found", { status: 404 });
      }

      callCount++;
      const body = parseRefreshBody(init);

      if (!validTokens.has(body.refresh_token)) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Token not found" }),
          { status: 400 }
        );
      }

      validTokens.delete(body.refresh_token);
      const newToken = `rotated-${callCount}`;
      validTokens.add(newToken);

      return bergetRefreshResponse(`access-${callCount}`, newToken, 300);
    };

    const creds = expiredCreds("initial-refresh-token");

    const r1 = await refreshBergetToken(creds);
    expect(r1.access).toBe("access-1");
    expect(r1.refresh).toBe("rotated-1");

    const r2 = await refreshBergetToken(r1);
    expect(r2.access).toBe("access-2");
    expect(r2.refresh).toBe("rotated-2");

    const r3 = await refreshBergetToken(r2);
    expect(r3.access).toBe("access-3");
    expect(r3.refresh).toBe("rotated-3");

    await expect(refreshBergetToken(r1)).rejects.toThrow("Token refresh failed");
  });
});
