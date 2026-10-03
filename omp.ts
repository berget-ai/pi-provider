/**
 * Oh My Pi (OMP) extension entry point for the Berget AI provider.
 *
 * OMP's legacy-pi compatibility layer does not expose the pi-ai 1.0
 * `createProvider` API used by `index.ts` (can1357/oh-my-pi#9024), so this
 * entry registers through OMP's config-based registerProvider(name, config)
 * instead. All provider logic is shared with the Pi entry via
 * `shared.ts`; only the registration and the OAuth UI-callback adaptation
 * differ. Selected through the `omp.extensions` manifest field, which OMP
 * prefers over `pi.extensions`.
 *
 * Differences from the Pi entry: the login flow offers the browser PKCE flow
 * only (OMP's login callbacks have no select prompt or device-code event for
 * the QR device flow), and System One classifiers are not registered (OMP's
 * `ProviderConfig` has no classifier surface).
 *
 * @packageDocumentation
 */
import type { Model, OAuthCredential } from '@earendil-works/pi-ai';

import {
  buildAuthUrl,
  exchangeToken,
  fetchBergetModels,
  generatePKCE,
  generateRandomString,
  getInferenceUrl,
  getOAuthTimeoutMs,
  parseCodeFromInput,
  refreshBergetToken,
  startCallbackServer,
} from './shared.ts';

// === Structural OMP types ===
//
// Minimal slices of OMP's extension API, declared structurally so the package
// does not depend on `@oh-my-pi/*` packages. Mirrors
// `ExtensionAPI.registerProvider`/`ProviderConfig`
// (@oh-my-pi/pi-coding-agent) and `OAuthLoginCallbacks`/`OAuthCredentials`
// (@oh-my-pi/pi-ai oauth/types), validated against OMP 18.x.

/** Slice of OMP's `OAuthAuthInfo`: the sign-in URL shown by the login UI. */
export interface OmpAuthInfo {
  url: string;
  instructions?: string;
}

/** Slice of OMP's `OAuthLoginCallbacks` used by {@link loginBergetOmp}. */
export interface OmpOAuthLoginCallbacks {
  onAuth?: (info: OmpAuthInfo) => void;
  onProgress?: (message: string) => void;
  onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

/** Slice of OMP's `OAuthCredentials` credential shape. */
export interface OmpOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

/** Slice of OMP's `ProviderConfig` fields this entry sets. */
export interface OmpProviderConfig {
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  baseUrl?: string;
  fetchDynamicModels?: (apiKey?: string) => Promise<readonly Model<'openai-completions'>[]>;
  models?: readonly Model<'openai-completions'>[];
  name?: string;
  oauth?: {
    name: string;
    login: (callbacks: OmpOAuthLoginCallbacks) => Promise<OmpOAuthCredentials | string>;
    refreshToken?: (
      credentials: OmpOAuthCredentials,
      signal?: AbortSignal,
    ) => Promise<OmpOAuthCredentials>;
    getApiKey?: (credentials: OmpOAuthCredentials) => string;
  };
}

/** Slice of OMP's `ExtensionAPI` used by the default export. */
export interface OmpExtensionApi {
  registerProvider: (name: string, config: OmpProviderConfig) => void;
}

type CallbackServer = Awaited<ReturnType<typeof startCallbackServer>>;

// === Extension Entry Point ===

/**
 * OMP extension entry point. Mirrors the Pi entry's unconditional startup
 * fetch so the catalog is visible before login; a throw aborts registration.
 *
 * @remarks `apiKey: 'BERGET_API_KEY'` is an environment variable reference:
 *          OMP resolves config values against the environment first, so a set
 *          `BERGET_API_KEY` authenticates without login, and a stored OAuth
 *          credential wins over the fallback when both exist.
 */
export default async function (pi: OmpExtensionApi): Promise<void> {
  const models = await fetchBergetModels();

  pi.registerProvider('berget', {
    api: 'openai-completions',
    apiKey: 'BERGET_API_KEY',
    authHeader: true,
    baseUrl: getInferenceUrl(),
    fetchDynamicModels: () => fetchBergetModels(),
    models,
    name: 'Berget AI',
    oauth: {
      getApiKey: (credential) => credential.access,
      login: (callbacks) => loginBergetOmp(callbacks),
      name: 'Berget AI',
      refreshToken: (credential, signal) =>
        refreshBergetToken({ ...credential, type: 'oauth' }, signal),
    },
  });
}

/**
 * Run the browser PKCE login flow against OMP's OAuth callbacks.
 *
 * Adapts the shared flow pieces to OMP's callback surface: `onAuth` presents
 * the sign-in URL, `onManualCodeInput` collects a pasted redirect URL/code on
 * remote machines, and `onProgress` reports token exchange.
 *
 * @returns Access/refresh credentials with an expiry timestamp.
 * @throws `Missing authorization code` on timeout with no code received.
 */
async function loginBergetOmp(callbacks: OmpOAuthLoginCallbacks): Promise<OAuthCredential> {
  const { challenge, verifier } = await generatePKCE();
  const state = generateRandomString();
  const authUrl = buildAuthUrl(challenge, state);

  callbacks.onAuth?.({
    instructions:
      'Complete login in your browser. If the browser is on another machine, ' +
      'paste the full redirect URL when prompted.',
    url: authUrl,
  });

  const callbackServer = await startCallbackServer(state);
  try {
    const code = await waitForAuthorizationCode(callbackServer, callbacks);
    if (!code) {
      throw new Error('Missing authorization code');
    }
    callbacks.onProgress?.('Exchanging authorization code for tokens...');
    return await exchangeToken(code, verifier);
  } finally {
    callbackServer.close();
  }
}

/**
 * Resolve an authorization code from the loopback callback server or a manual
 * paste, whichever arrives first, bounded by {@link getOAuthTimeoutMs}.
 *
 * @remarks Mirrors `resolveManualCode` in `shared.ts` but sources manual input
 *          from OMP's `onManualCodeInput`. A manual-input rejection (e.g. user
 *          cancellation) aborts the login. Promises raced here stay subscribed
 *          through `Promise.race`, so late settlements cannot surface as
 *          unhandled rejections.
 * @returns The authorization code, or `null` on timeout.
 */
async function waitForAuthorizationCode(
  callbackServer: CallbackServer,
  callbacks: OmpOAuthLoginCallbacks,
): Promise<null | string> {
  const manualPromise = callbacks.onManualCodeInput
    ? callbacks.onManualCodeInput(callbacks.signal).then(
        (input) => {
          callbackServer.cancelWait();
          return parseCodeFromInput(input);
        },
        (error: unknown) => {
          callbackServer.cancelWait();
          throw error instanceof Error ? error : new Error(String(error));
        },
      )
    : undefined;

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      callbackServer.cancelWait();
      resolve(null);
    }, getOAuthTimeoutMs());
  });

  return Promise.race([
    callbackServer.waitForCode().then((result) => result?.code ?? null),
    ...(manualPromise ? [manualPromise] : []),
    timeoutPromise,
  ]);
}
