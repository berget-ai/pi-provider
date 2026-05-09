import * as http from "node:http";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

// === Constants ===

const DEFAULT_MAX_TOKENS = 16384;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const KEYCLOAK_CLIENT_ID = "berget-code";
const CALLBACK_PORT = 8787;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const OAUTH_TIMEOUT_MS = () => parseInt(process.env.BERGET_OAUTH_TIMEOUT_MS || "300000", 10);

// === Model Capability Overrides ===
// Manual overrides for model capabilities not returned by /v1/models/chat.
// Hugging Face model cards are the source of truth for these values.

const MODEL_OVERRIDES: Record<string, Partial<ProviderModelConfig>> = {
  "openai/gpt-oss-120b": {
    reasoning: true,
  },
  "mistralai/Mistral-Medium-3.5-128B": {
    input: ["text", "image"],
    reasoning: true,
  },
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
    input: ["text", "image"],
    reasoning: false,
  },
  "zai-org/GLM-4.7-FP8": {
    reasoning: true,
  },
  "google/gemma-4-31B-it": {
    input: ["text", "image"],
    reasoning: true,
  },
  "meta-llama/Llama-3.3-70B-Instruct": {
    reasoning: false,
  },
  "meta-llama/Llama-3.1-8B-Instruct": {
    reasoning: false,
  },
};

// === URL Helpers ===

function getInferenceUrl(): string {
  return process.env.BERGET_INFERENCE_URL || "https://api.berget.ai/v1";
}

function getAuthUrl(): string {
  return process.env.BERGET_AUTH_URL || "https://keycloak.berget.ai";
}

function getApiUrl(): string {
  return process.env.BERGET_API_URL || "https://api.berget.ai";
}

// === Model Fetching & Mapping ===

interface BergetModel {
  id: string;
  contextWindow: number;
  inputPricePerToken: number;
  outputPricePerToken: number;
}

interface BergetModelResponse {
  models: BergetModel[];
}

export function mapModelToProviderConfig(model: BergetModel): ProviderModelConfig {
  const base: ProviderModelConfig = {
    id: model.id,
    name: model.id,
    reasoning: false,
    input: ["text"],
    cost: {
      input: model.inputPricePerToken * 1e6,
      output: model.outputPricePerToken * 1e6,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
    },
  };

  const override = MODEL_OVERRIDES[model.id];
  return override ? { ...base, ...override } : base;
}

export async function fetchBergetModels(): Promise<ProviderModelConfig[]> {
  const apiUrl = getApiUrl();
  const response = await fetch(`${apiUrl}/v1/models/chat`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as BergetModelResponse;
  return data.models.map(mapModelToProviderConfig);
}

// === OAuth ===

// === Callback Server ===

interface CallbackResult {
  code: string;
  state: string;
}

function oauthResponseHtml(success: boolean, message: string): string {
  const color = success ? "#4ade80" : "#f87171";
  const bg = success ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const icon = success
    ? `<polyline points="20 6 9 17 4 12"/>`
    : `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Berget - ${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(135deg,#0f0f1a,#1a1a2e 50%,#16213e);color:#fff}.container{text-align:center;padding:3rem;max-width:400px}.icon{width:80px;height:80px;background:linear-gradient(135deg,${color},${color});border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;box-shadow:0 4px 20px ${bg}}.icon svg{width:40px;height:40px;stroke:#fff;stroke-width:3;fill:none}h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}p{color:#94a3b8;font-size:.95rem;line-height:1.5}.brand{margin-top:2rem;opacity:.5;font-size:.8rem;letter-spacing:.05em}</style></head><body><div class="container"><div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icon}</svg></div><h1>${title}</h1><p>${message}</p><div class="brand">BERGET</div></div></body></html>`;
}

function startCallbackServer(expectedState: string): Promise<{
  server: http.Server;
  waitForCode: () => Promise<CallbackResult | null>;
  cancelWait: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settleWait: ((value: CallbackResult | null) => void) | null = null;
    let settled = false;

    const waitForCodePromise = new Promise<CallbackResult | null>(resolveWait => {
      settleWait = value => {
        if (settled) return;
        settled = true;
        resolveWait(value);
      };
    });

    const server = http.createServer((req, res) => {
      try {
        const parsed = new URL(req.url || "/", "http://localhost");
        if (parsed.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthResponseHtml(false, "Not found."));
          return;
        }
        const code = parsed.searchParams.get("code");
        const state = parsed.searchParams.get("state");
        const error = parsed.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthResponseHtml(false, error));
          settleWait?.(null);
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthResponseHtml(false, "Missing authorization code."));
          settleWait?.(null);
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthResponseHtml(false, "State mismatch. Please try again."));
          settleWait?.(null);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthResponseHtml(true, "You can close this window and return to Pi."));
        settleWait?.({ code, state });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${CALLBACK_PORT} is already in use. Close other applications using this port.`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      const timeout = setTimeout(() => {
        settleWait?.(null);
      }, OAUTH_TIMEOUT_MS());

      resolve({
        server,
        waitForCode: () => {
          return waitForCodePromise.finally(() => clearTimeout(timeout));
        },
        cancelWait: () => settleWait?.(null),
      });
    });
  });
}

// === OAuth ===

function parseCodeFromInput(input: string): string | null {
  try {
    const parsed = new URL(input);
    return parsed.searchParams.get("code");
  } catch {
    return input.trim() || null;
  }
}

export async function loginBerget(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const authBaseUrl = getAuthUrl();
  const { verifier, challenge } = await generatePKCE();
  const state = generateRandomString();

  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid email profile offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${authBaseUrl}/realms/berget/protocol/openid-connect/auth?${params.toString()}`;

  let code: string | null = null;
  let callbackServer: Awaited<ReturnType<typeof startCallbackServer>> | null = null;

  try {
    callbackServer = await startCallbackServer(state);

    callbacks.onAuth({
      url: authUrl,
      instructions:
        "Complete login in your browser. If the browser is on another machine, paste the full redirect URL here.",
    });

    if (callbacks.onManualCodeInput) {
      let manualInput: string | undefined;
      let manualError: Error | undefined;

      const manualPromise = callbacks
        .onManualCodeInput()
        .then(input => {
          manualInput = input;
          callbackServer!.cancelWait();
        })
        .catch(err => {
          manualError = err instanceof Error ? err : new Error(String(err));
          callbackServer!.cancelWait();
        });

      const result = await callbackServer.waitForCode();

      if (result?.code) {
        code = result.code;
      } else if (manualInput) {
        code = parseCodeFromInput(manualInput);
      }

      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualInput) code = parseCodeFromInput(manualInput);
      }
    } else {
      const result = await callbackServer.waitForCode();
      if (result?.code) code = result.code;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("EADDRINUSE")) throw err;
  } finally {
    callbackServer?.server.close();
  }

  if (!code) {
    code = await callbacks.onPrompt({
      message: "Enter the authorization code from the callback URL",
      placeholder: "Authorization code",
    });
  }

  if (!code) {
    throw new Error("Missing authorization code");
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");

  const tokenResponse = await fetch(`${authBaseUrl}/realms/berget/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: KEYCLOAK_CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorBody}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - ACCESS_TOKEN_EXPIRY_BUFFER_MS,
  };
}

export async function refreshBergetToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const apiUrl = getApiUrl();
  const response = await fetch(`${apiUrl}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: credentials.refresh,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    refresh: data.refresh_token || credentials.refresh,
    access: data.token,
    expires: Date.now() + data.expires_in * 1000 - ACCESS_TOKEN_EXPIRY_BUFFER_MS,
  };
}

// === PKCE Helpers ===

function generateRandomString(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
}

function base64URLEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64URLEncode(verifierBytes.buffer as ArrayBuffer);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64URLEncode(digest);
  return { verifier, challenge };
}

// === Extension Entry Point ===

export default async function (pi: ExtensionAPI): Promise<void> {
  const models = await fetchBergetModels();

  pi.registerProvider("berget", {
    name: "Berget AI",
    baseUrl: getInferenceUrl(),
    apiKey: "BERGET_API_KEY",
    authHeader: true,
    api: "openai-completions",
    models,
    oauth: {
      name: "Berget AI",
      login: loginBerget,
      refreshToken: refreshBergetToken,
      getApiKey: cred => cred.access,
    },
  });
}
