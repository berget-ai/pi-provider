import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { Socket } from 'node:net';

import * as http from 'node:http';

// === Constants ===

const DEFAULT_MAX_TOKENS = 16_384;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const KEYCLOAK_CLIENT_ID = 'berget-code';
const CALLBACK_PORT = 8787;
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://127.0.0.1:${String(CALLBACK_PORT)}${CALLBACK_PATH}`;
const OAUTH_TIMEOUT_MS = (): number =>
  Number.parseInt(process.env.BERGET_OAUTH_TIMEOUT_MS || '300000', 10);

// === Model Capability Overrides ===
// Manual overrides for model capabilities not returned by /v1/models/chat.
// Hugging Face model cards are the source of truth for these values.

const MODEL_OVERRIDES: Record<string, Partial<ProviderModelConfig>> = {
  'google/gemma-4-31B-it': {
    input: ['text', 'image'],
    reasoning: true,
    // Gemma 4 reasoning is a binary enable_thinking flag, so only off/high
    // are meaningful. Holes collapse to the nearest supported level.
    thinkingLevelMap: {
      high: 'high',
      low: null,
      max: null,
      medium: null,
      minimal: null,
      off: 'none',
      xhigh: null,
    },
  },
  'meta-llama/Llama-3.1-8B-Instruct': {
    reasoning: false,
  },
  'meta-llama/Llama-3.3-70B-Instruct': {
    reasoning: false,
  },
  'mistralai/Mistral-Medium-3.5-128B': {
    input: ['text', 'image'],
    reasoning: true,
    // vLLM --reasoning-parser mistral honors OpenAI-style reasoning_effort.
    thinkingLevelMap: {
      high: 'high',
      low: null,
      max: null,
      medium: 'medium',
      minimal: null,
      off: 'none',
      xhigh: null,
    },
  },
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506': {
    input: ['text', 'image'],
    reasoning: false,
  },
  'moonshotai/Kimi-K2.6': {
    input: ['text', 'image'],
    reasoning: true,
    // Kimi K2 thinking.type is enabled/disabled — binary, so only off/high.
    thinkingLevelMap: {
      high: 'high',
      low: null,
      max: null,
      medium: null,
      minimal: null,
      off: 'none',
      xhigh: null,
    },
  },
  'openai/gpt-oss-120b': {
    reasoning: true,
    // gpt-oss passes reasoning_effort through to vLLM; expose the ladder.
    thinkingLevelMap: {
      high: 'high',
      low: null,
      max: null,
      medium: 'medium',
      minimal: null,
      off: 'none',
      xhigh: 'xhigh',
    },
  },
  'zai-org/GLM-4.7-FP8': {
    reasoning: true,
    // GLM-4.7 enable_thinking is binary — only off/high.
    thinkingLevelMap: {
      high: 'high',
      low: null,
      max: null,
      medium: null,
      minimal: null,
      off: 'none',
      xhigh: null,
    },
  },
  'zai-org/GLM-5.2': {
    maxTokens: 32_768,
    reasoning: true,
    // GLM-5.2 exposes a real effort knob (high/max) via chat_template_kwargs.
    thinkingLevelMap: {
      high: 'high',
      low: null,
      max: 'max',
      medium: null,
      minimal: null,
      off: 'none',
      xhigh: null,
    },
  },
};

// === URL Helpers ===

interface BergetModel {
  contextWindow: number;
  id: string;
  inputPricePerToken: number;
  outputPricePerToken: number;
}

interface CallbackResult {
  code: string;
  state: string;
}

export async function _collectAuthCode(
  callbacks: OAuthLoginCallbacks,
  authUrl: string,
  state: string,
  serverFactory: typeof startCallbackServer,
): Promise<null | string> {
  let callbackServer: Awaited<ReturnType<typeof startCallbackServer>> | null = null;

  try {
    callbackServer = await serverFactory(state);

    // `onAuth` is typed `void`, but provider implementations may return a Promise;
    // awaiting via Promise.resolve preserves async-rejection propagation.
    const authInfo = {
      instructions:
        'Complete login in your browser. If the browser is on another machine, paste the full redirect URL here.',
      url: authUrl,
    };
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
    await Promise.resolve(callbacks.onAuth(authInfo));

    let code: null | string = null;
    if (callbacks.onManualCodeInput) {
      code = await resolveManualCode(callbackServer, callbacks);
    } else {
      const result = await callbackServer.waitForCode();
      code = result?.code ?? null;
    }

    if (code) return code;
  } finally {
    callbackServer?.close();
  }

  return callbacks.onPrompt({
    message: 'Enter the authorization code from the callback URL',
    placeholder: 'Authorization code',
  });
}

export function buildAuthUrl(challenge: string, state: string): string {
  const authBaseUrl = getAuthUrl();
  const parameters = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile offline_access',
    state,
  });
  return `${authBaseUrl}/realms/berget/protocol/openid-connect/auth?${parameters.toString()}`;
}

export async function collectAuthCode(
  callbacks: OAuthLoginCallbacks,
  authUrl: string,
  state: string,
): Promise<null | string> {
  return _collectAuthCode(callbacks, authUrl, state, startCallbackServer);
}

// === Model Fetching & Mapping ===

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export async function exchangeToken(code: string, verifier: string): Promise<OAuthCredentials> {
  const authBaseUrl = getAuthUrl();
  const tokenResponse = await fetch(`${authBaseUrl}/realms/berget/protocol/openid-connect/token`, {
    body: new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${String(tokenResponse.status)} ${errorBody}`);
  }

  const tokenData: unknown = await tokenResponse.json();
  if (!isKeycloakTokenResponse(tokenData)) {
    throw new Error(
      'Invalid token response: expected { access_token: string, expires_in: number, refresh_token: string }',
    );
  }

  return {
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - ACCESS_TOKEN_EXPIRY_BUFFER_MS,
    refresh: tokenData.refresh_token,
  };
}

export async function fetchBergetModels(): Promise<ProviderModelConfig[]> {
  const apiUrl = getApiUrl();
  const response = await fetch(`${apiUrl}/v1/models/chat`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${String(response.status)} ${response.statusText}`);
  }
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as Record<string, unknown>).models)
  ) {
    throw new Error('Malformed model list response: expected { models: [...] }');
  }
  return ((data as Record<string, unknown>).models as BergetModel[]).map((model) =>
    mapModelToProviderConfig(model),
  );
}

export async function generatePKCE(): Promise<{ challenge: string; verifier: string }> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64URLEncode(verifierBytes.buffer);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64URLEncode(digest);
  return { challenge, verifier };
}

export async function loginBerget(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { challenge, verifier } = await generatePKCE();
  const state = generateRandomString();

  const authUrl = buildAuthUrl(challenge, state);

  const code = await collectAuthCode(callbacks, authUrl, state);

  if (!code) {
    throw new Error('Missing authorization code');
  }

  callbacks.onProgress?.('Exchanging authorization code for tokens...');

  return exchangeToken(code, verifier);
}

export function mapModelToProviderConfig(model: BergetModel): ProviderModelConfig {
  const base: ProviderModelConfig = {
    compat: {
      supportsDeveloperRole: false,
    },
    contextWindow: model.contextWindow,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: model.inputPricePerToken * 1e6,
      output: model.outputPricePerToken * 1e6,
    },
    id: model.id,
    input: ['text'],
    maxTokens: DEFAULT_MAX_TOKENS,
    name: model.id,
    reasoning: false,
  };

  return { ...base, ...MODEL_OVERRIDES[model.id] };
}

export function oauthResponseHtml(success: boolean, message: string): string {
  const color = success ? '#4ade80' : '#f87171';
  const bg = success ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)';
  const title = success ? 'Authentication Successful' : 'Authentication Failed';
  const icon = success
    ? `<polyline points="20 6 9 17 4 12"/>`
    : `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Berget - ${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(135deg,#0f0f1a,#1a1a2e 50%,#16213e);color:#fff}.container{text-align:center;padding:3rem;max-width:400px}.icon{width:80px;height:80px;background:linear-gradient(135deg,${color},${color});border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;box-shadow:0 4px 20px ${bg}}.icon svg{width:40px;height:40px;stroke:#fff;stroke-width:3;fill:none}h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}p{color:#94a3b8;font-size:.95rem;line-height:1.5}.brand{margin-top:2rem;opacity:.5;font-size:.8rem;letter-spacing:.05em}</style></head><body><div class="container"><div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icon}</svg></div><h1>${title}</h1><p>${escapeHtml(message)}</p><div class="brand">BERGET</div></div></body></html>`;
}

// === Callback Server ===

export async function refreshBergetToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const apiUrl = getApiUrl();
  const response = await fetch(`${apiUrl}/v1/auth/refresh`, {
    body: JSON.stringify({
      refresh_token: credentials.refresh,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${String(response.status)} ${errorText}`);
  }

  const data: unknown = await response.json();
  if (!isBergetTokenResponse(data)) {
    throw new Error(
      'Invalid token response: expected { token: string, expires_in: number, refresh_token?: string }',
    );
  }

  return {
    access: data.token,
    expires: Date.now() + data.expires_in * 1000 - ACCESS_TOKEN_EXPIRY_BUFFER_MS,
    refresh: data.refresh_token || credentials.refresh,
  };
}

export function resolveInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// === OAuth ===

export async function resolveManualCode(
  callbackServer: Awaited<ReturnType<typeof startCallbackServer>>,
  callbacks: OAuthLoginCallbacks,
): Promise<null | string> {
  if (!callbacks.onManualCodeInput) return null;

  let manualInput: string | undefined;
  let manualError: Error | undefined;

  const manualPromise = callbacks
    .onManualCodeInput()
    .then((input) => {
      manualInput = input;
      callbackServer.cancelWait();
      return input;
    })
    .catch((error: unknown) => {
      manualError = error instanceof Error ? error : new Error(String(error));
      callbackServer.cancelWait();
    });

  const result = await callbackServer.waitForCode();

  if (result?.code) return result.code;
  if (manualInput) return parseCodeFromInput(manualInput);

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      callbackServer.cancelWait();
      resolve(null);
    }, OAUTH_TIMEOUT_MS());
  });

  const winner = await Promise.race([manualPromise, timeoutPromise]);

  if (winner === null) {
    // Timeout — fall through to onPrompt in collectAuthCode
    return null;
  }

  if (manualError) throw manualError;

  return manualInput ? parseCodeFromInput(manualInput) : null;
}

export function startCallbackServer(expectedState: string): Promise<{
  cancelWait: () => void;
  close: () => void;
  server: http.Server;
  waitForCode: () => Promise<CallbackResult | null>;
}> {
  return new Promise((resolve, reject) => {
    let settleWait: ((value: CallbackResult | null) => void) | null = null;
    let settled = false;

    const activeSockets = new Set<Socket>();

    const waitForCodePromise = new Promise<CallbackResult | null>((resolve) => {
      settleWait = (value: CallbackResult | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
    });

    const server = http.createServer((request, res) => {
      if (settleWait) {
        handleOAuthRequest(request, res, expectedState, settleWait);
      }
    });

    server.on('connection', (socket: Socket) => {
      activeSockets.add(socket);
      socket.once('close', () => activeSockets.delete(socket));
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${String(CALLBACK_PORT)} is already in use. Close other applications using this port.`,
          ),
        );
      } else {
        reject(error);
      }
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      const timeout = setTimeout(() => {
        settleWait?.(null);
      }, OAUTH_TIMEOUT_MS());

      resolve({
        cancelWait: () => {
          clearTimeout(timeout);
          settleWait?.(null);
        },
        close: () => {
          clearTimeout(timeout);
          for (const socket of activeSockets) {
            socket.destroy();
          }
          activeSockets.clear();
          server.close();
        },
        server,
        waitForCode: () => waitForCodePromise,
      });
    });
  });
}

function base64URLEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let string_ = '';
  for (const byte of bytes) {
    string_ += String.fromCodePoint(byte);
  }
  return btoa(string_).replaceAll('+', '-').replaceAll('/', '_').split('=')[0];
}

function generateRandomString(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getApiUrl(): string {
  return process.env.BERGET_API_URL || 'https://api.berget.ai';
}

// === PKCE Helpers ===

function getAuthUrl(): string {
  return process.env.BERGET_AUTH_URL || 'https://keycloak.berget.ai';
}

function getInferenceUrl(): string {
  return process.env.BERGET_INFERENCE_URL || 'https://api.berget.ai/v1';
}

function handleOAuthRequest(
  request: http.IncomingMessage,
  res: http.ServerResponse,
  expectedState: string,
  settleWait: (value: CallbackResult | null) => void,
): void {
  try {
    const parsed = new URL(request.url || '/', 'http://localhost');
    if (parsed.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { Connection: 'close', 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthResponseHtml(false, 'Not found.'));
      return;
    }
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    const error = parsed.searchParams.get('error');

    if (error) {
      res.writeHead(400, { Connection: 'close', 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthResponseHtml(false, error));
      settleWait(null);
      return;
    }
    if (!code || !state) {
      res.writeHead(400, { Connection: 'close', 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthResponseHtml(false, 'Missing authorization code.'));
      settleWait(null);
      return;
    }
    if (state !== expectedState) {
      res.writeHead(400, { Connection: 'close', 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthResponseHtml(false, 'State mismatch. Please try again.'));
      settleWait(null);
      return;
    }

    res.writeHead(200, { Connection: 'close', 'Content-Type': 'text/html; charset=utf-8' });
    res.end(oauthResponseHtml(true, 'You can close this window and return to Pi.'));
    settleWait({ code, state });
  } catch {
    res.writeHead(500, { Connection: 'close', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal error');
  }
}

function isBergetTokenResponse(
  data: unknown,
): data is { expires_in: number; refresh_token?: string; token: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'token' in data &&
    typeof (data as Record<string, unknown>).token === 'string' &&
    'expires_in' in data &&
    typeof (data as Record<string, unknown>).expires_in === 'number'
  );
}

function isKeycloakTokenResponse(
  data: unknown,
): data is { access_token: string; expires_in: number; refresh_token: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'access_token' in data &&
    typeof (data as Record<string, unknown>).access_token === 'string' &&
    'expires_in' in data &&
    typeof (data as Record<string, unknown>).expires_in === 'number' &&
    'refresh_token' in data &&
    typeof (data as Record<string, unknown>).refresh_token === 'string'
  );
}

function parseCodeFromInput(input: string): string {
  try {
    const url = new URL(input);
    const code = url.searchParams.get('code');
    if (code) return code;
  } catch {
    // Not a URL, treat as raw code
  }
  return input;
}

// === Extension Entry Point ===

export default async function (pi: ExtensionAPI): Promise<void> {
  const models = await fetchBergetModels();

  pi.registerProvider('berget', {
    api: 'openai-completions',
    apiKey: '$BERGET_API_KEY',
    authHeader: true,
    baseUrl: getInferenceUrl(),
    models,
    name: 'Berget AI',
    oauth: {
      getApiKey: (cred) => cred.access,
      login: loginBerget,
      name: 'Berget AI',
      refreshToken: refreshBergetToken,
    },
  });
}
