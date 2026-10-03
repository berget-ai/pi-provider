/**
 * Pi extension exposing Berget AI models as a custom provider.
 *
 * Exports an async factory function (the default export) that Pi awaits during
 * startup, so model discovery and provider registration complete before the
 * first prompt or model listing. The implementation lives in `shared.ts` and
 * is re-exported here for the test suite and existing importers; the Oh My Pi
 * entry point is `omp.ts`.
 *
 * @packageDocumentation
 */
import {
  createProvider,
  envApiKeyAuth,
  type AuthInteraction,
  type OAuthAuth,
  type OAuthCredential,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { classify } from '@earendil-works/pi-ai/api/typesafe-system-one';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  fetchBergetModels,
  getBergetClassifierModels,
  getInferenceUrl,
  loginBerget,
  refreshBergetToken,
} from './shared.ts';

export * from './shared.ts';

// === Extension Entry Point ===

/**
 * Pi extension entry point. Pi awaits this async factory during startup so
 * model discovery and provider registration complete before the first prompt
 * or `pi --list-models`. Registers the `berget` provider with OpenAI-compatible
 * streaming, the inference base URL, the OAuth login/refresh functions, and
 * the System One classifier transport.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  // Unconditional startup fetch preserves `pi --list-models` visibility for
  // unauthenticated users (matches the pre-migration behaviour). A throw here
  // aborts registration, same as before. See docs/persistence-migration.md
  // Risks #1 — `createProvider({ models: [] })` would leave the catalog empty
  // for logged-out users because `Models.refresh` skips providers with no
  // resolved credential.
  const models = await fetchBergetModels();

  pi.registerProvider(
    createProvider({
      api: openAICompletionsApi(),
      auth: {
        apiKey: envApiKeyAuth('Berget AI', ['BERGET_API_KEY']),
        oauth: bergetOAuthAuth(),
      },
      baseUrl: getInferenceUrl(),
      classifiers: { 'typesafe-system-one': { classify } },
      // `fetchModels` is the `ModelsStore`-persisted refresh path. Because it
      // returns pi-ai `Model<'openai-completions'>[]` directly, `createProvider`
      // can restore/persist it through the store — closing the shape gap that
      // blocked persistence on the legacy `ProviderConfig` form (PR #22).
      fetchModels: () => fetchBergetModels(),
      id: 'berget',
      models: [...models, ...getBergetClassifierModels()],
      name: 'Berget AI',
    }),
  );
}

/**
 * Build the Berget {@link OAuthAuth} by adapting the PKCE login/refresh flow to
 * `createProvider`'s `login`/`refresh`/`toAuth` shape.
 *
 * @remarks `toAuth` replaces the legacy `getApiKey: (cred) => cred.access` —
 *          the stored OAuth access token becomes the request `apiKey`.
 */
function bergetOAuthAuth(): OAuthAuth {
  return {
    isSubscription: true,
    login: (interaction: AuthInteraction) => loginBerget(interaction),
    loginLabel: 'Sign in with Berget Code',
    name: 'Berget AI',
    refresh: (credential: OAuthCredential, signal?: AbortSignal) =>
      refreshBergetToken(credential, signal),
    toAuth: (credential: OAuthCredential) => Promise.resolve({ apiKey: credential.access }),
  };
}
