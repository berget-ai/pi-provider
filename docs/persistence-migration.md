# Migration plan: `createProvider()` full-provider form + `ModelsStore` persistence

> **Status:** WIP scratch branch `feat/full-provider-persistence` (commit `644cb4a`, local-only, **DO NOT MERGE**). This document captures the verified `Step 0` API investigation so the next attempt does not re-investigate. See the `impl-plan` section for the ordered work.

## Goal

Deliver the **`context.store` model-catalog persistence** that was deferred in PR #22. The deferred work was blocked at the `^0.80.10` SDK because `refreshModels(context)` returns `ProviderModelConfig[]` while `context.store` holds pi-ai `Model<Api>[]`, and pi does not export the `ProviderModelConfig -> Model` converter (`applyExtension` is internal).

**pi v0.81.0 ("Full provider extensions") removes that blocker:** extensions can register a *complete pi-ai `Provider`* via `createProvider()`, with native `auth`, `fetchModels` (dynamic discovery that `createProvider` + `ModelsStore` persist in the `Model[]` shape — so the conversion gap disappears), `filterModels`, and `stream`/`streamSimple`. Quoting the v0.82.1 docs: *"The object form accepts a complete pi-ai `Provider`, including native `auth`, `getModels`, `refreshModels`, `filterModels`, `stream`, and `streamSimple` behavior."*

This is **only achievable on `>= v0.81.0`** — the object-form `registerProvider(provider: Provider)` overload is the gating v0.81.0 addition (verified: absent in installed 0.80.10's `ExtensionAPI`; present at line 986 of `types.d.ts` in installed 0.81.1). The legacy `registerProvider(name, ProviderConfig)` form (what PR #22 uses) still works on 0.81.x via the internal `adaptOAuth` adapter, so a floor bump alone is safe — but it does **not** deliver persistence. Persistence requires the full rewrite.

## Verified Step 0 findings — the new API surface

All type shapes below were verified against the **installed `pi-ai@0.81.1` / `pi-coding-agent@0.81.1`** (matching v0.82.1's docs; v0.81.0 is the minimum).

### `createProvider(input: CreateProviderOptions): Provider<TApi>` — from `@earendil-works/pi-ai` (root)
```ts
export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string;                      // required — "berget"
  name?: string;                    // "Berget AI"
  baseUrl?: string;                // getInferenceUrl()
  headers?: ProviderHeaders;
  auth: ProviderAuth;              // REQUIRED — { apiKey?, oauth? }, >=1 present
  models: readonly Model<TApi>[];  // REQUIRED — baseline list; [] for purely dynamic
  fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
  filterModels?: (models, credential) => readonly Model<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;  // REQUIRED
}
```
`createProvider` + `fetchModels` own persistence automatically — *"createProvider restores/persists it through `ModelsStore`"* (pi-ai `models.d.ts` doc comment). **No manual `store.write` is needed in the extension**, unlike the legacy `refreshModels(context)` where the extension was *expected* to do store I/O (and couldn't, due to the shape gap).

### `ProviderAuth` — required `auth` field
```ts
export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
}  // at least one of apiKey/oauth must be present
```
For Berget (supports env-key *and* OAuth), set both: `apiKey: envApiKeyAuth('Berget AI', ['BERGET_API_KEY'])` and `oauth: { … AuthInteraction form … }`. `envApiKeyAuth` is exported from `@earendil-works/pi-ai` root (re-exported from `auth/helpers.ts`).

### `OAuthAuth` — the OAuth migration (replaces the legacy `oauth: { login, refreshToken, getApiKey }` block)
```ts
export interface OAuthAuth {
  name: string;                                            // was oauth.name
  loginLabel?: string;                                     // NEW — "Sign in with..." for the login selector
  login(interaction: AuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;  // throws on failure
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;  // NEW — replaces getApiKey(cred) => cred.access
}
```
**Key behavioural change:** `Models` owns the locked refresh — it calls `refresh` under the credential-store lock and `toAuth` derives request auth from whatever credential is stored. The extension no longer hand-rolls expiry-check / reuse-already-rotated-token logic (it currently doesn't, post-PR-#16, so this is a simplification).

### `AuthInteraction` — replaces `OAuthLoginCallbacks`
```ts
export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;   // discriminates: text | secret | select | manual_code
  notify(event: AuthEvent): void;                // discriminates: info | auth_url | device_code | progress
}
```

#### Callback mapping (legacy `OAuthLoginCallbacks` -> new `AuthInteraction`)
| Legacy | New |
|---|---|
| `callbacks.onAuth({ url, instructions })` | `interaction.notify({ type: 'auth_url', url, instructions })` |
| `callbacks.onDeviceCode({ userCode, verificationUri, … })` | `interaction.notify({ type: 'device_code', userCode, verificationUri, … })` |
| `callbacks.onProgress?.(message)` | `interaction.notify({ type: 'progress', message })` |
| `callbacks.onPrompt({ message, placeholder })` -> `Promise<string>` | `interaction.prompt({ type: 'text', message, placeholder })` -> `Promise<string>` |
| `callbacks.onManualCodeInput?.()` -> `Promise<string>` (races the callback server) | `interaction.prompt({ type: 'manual_code', message, placeholder, signal })` — the per-prompt `signal` aborts the prompt when the callback server wins |
| `callbacks.onSelect?.({ message, options })` | `interaction.prompt({ type: 'select', message, options })` |
| `callbacks.signal?` | `interaction.signal?` |

### `OAuthCredential` vs `OAuthCredentials`
```ts
export interface OAuthCredentials { refresh: string; access: string; expires: number; [key: string]: unknown; }
export interface OAuthCredential extends OAuthCredentials { type: 'oauth'; }   // add type: 'oauth'
```
`exchangeToken` and `refreshBergetToken` must add `type: 'oauth'` to their returned object and be typed `Promise<OAuthCredential>` (currently `Promise<OAuthCredentials>`).

### `Model<'openai-completions'>` — replaces `ProviderModelConfig[]`
```ts
export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;                       // REQUIRED (was optional `api?` on ProviderModelConfig) — 'openai-completions'
  provider: ProviderId;            // REQUIRED — 'berget' (ProviderId = KnownProvider | string, so custom ids are valid)
  baseUrl: string;                 // REQUIRED (was optional) — getInferenceUrl()
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;       // same type as before
  input: ('text' | 'image')[];
  cost: ModelCost;                  // same type as before (ModelCost = { input, output, cacheRead, cacheWrite, tiers? })
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: TApi extends 'openai-completions' ? OpenAICompletionsCompat : …;  // same compat fields
}
```
`ProviderId = KnownProvider | string` — verified open, so `provider: 'berget'` typechecks. The existing `MODEL_OVERRIDES` values (only `input`/`reasoning`/`thinkingLevelMap`/`maxTokens`) are all valid on `Model`; only the override-bucket **type** changes from `Record<string, Partial<ProviderModelConfig>>` to `Record<string, Partial<Model<'openai-completions'>>>`.

### `api` runtime import (the new required value)
`openAICompletionsApi(): ProviderStreams` is imported from the **lazy subpath**:
```ts
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
```
It is NOT re-exported from the root `index.d.ts` (verified). `envApiKeyAuth` and `lazyOAuth` ARE on root (via `export * from "./auth/helpers.ts"`).

## impl-plan — ordered work for completing the migration

The WIP branch (`644cb4a`) changed `index.ts` imports, `MODEL_OVERRIDES` type, `mapModelToProviderConfig` -> `mapBergetModelToModel` (returns `Model<'openai-completions'>`), `loginBerget` signature, `exchangeToken` return, and `_collectAuthCode` — but **left the work incomplete and the gate RED**. Resume from here:

### index.ts (7 changes)

1. **Imports** — done in WIP. Verify: `createProvider`, `envApiKeyAuth`, `AuthInteraction`, `Model`, `OAuthCredential`, `OAuthCredentials`, `OAuthAuth`, `RefreshModelsContext` from `@earendil-works/pi-ai` root; `openAICompletionsApi` from `@earendil-works/pi-ai/api/openai-completions.lazy`; `ExtensionAPI` from `@earendil-works/pi-coding-agent`. Drop the now-unused `OAuthLoginCallbacks`/`ProviderModelConfig` imports.
2. **`MODEL_OVERRIDES`** — type changed to `Record<string, Partial<Model<'openai-completions'>>>` in WIP. Values unchanged.
3. **`fetchBergetModels()`** — returns `Model<'openai-completions'>[]` (done in WIP; was `ProviderModelConfig[]`). `mapBergetModelToModel` (renamed from `mapModelToProviderConfig`) adds `api: 'openai-completions'`, `provider: 'berget'`, `baseUrl: getInferenceUrl()` (done in WIP).
4. **OAuth: `loginBerget(interaction: AuthInteraction)`** — signature moved in WIP; notify/prompt calls migrated. ✅-ish — needs the `_collectAuthCode` rewrite re-examined (see #5).
5. **`_collectAuthCode` — RESTORE the proven race logic.** The WIP commit replaced the carefully-designed `resolveManualCode` two-phase race with a simpler `manual_code` prompt + `AbortController` pattern **that has not been verified against `oauth-callback-errors.test.ts`**. **Before keeping it**, re-run `oauth-callback-errors.test.ts` mental model against the new code: the cases there are (state mismatch, missing code, network error, port-in-use, timeout, manual-input-wins, callback-wins). The cleanest path is **restore `resolveManualCode`** but change its signature from `OAuthLoginCallbacks` to `AuthInteraction` and translate: `onManualCodeInput()` -> `interaction.prompt({ type: 'manual_code', signal: perPromptSignal })`; keep the existing `Promise.race` against `waitForCode` + `getOAuthTimeoutMs()` timeout. This preserves the tested logic rather than rewriting it.
6. **`refreshBergetToken(credential: OAuthCredential, signal?): Promise<OAuthCredential>`** — signature change: add `signal?: AbortSignal` param (thread into the `fetch`); add `type: 'oauth'` to the returned object; declare return `Promise<OAuthCredential>`. (WIP changed the return type of `exchangeToken`; do the same here.)
7. **Factory — wire `createProvider`** (NOT done in WIP; line ~824 still has the legacy `oauth: { login: loginBerget, … }` block):
   ```ts
   export default async function (pi: ExtensionAPI): Promise<void> {
     const models = await fetchBergetModels();  // <-- remove. createProvider takes [] + fetchModels; the factory should NOT pre-fetch (createProvider populates lazily). DECISION: keep a startup fetch for /model immediacy by passing models: await fetchBergetModels(), AND set fetchModels for refresh. Verify createProvider semantics for "models provided at construction time + fetchModels".
     pi.registerProvider(
       createProvider({
         id: 'berget',
         name: 'Berget AI',
         baseUrl: getInferenceUrl(),
         auth: {
           apiKey: envApiKeyAuth('Berget AI', ['BERGET_API_KEY']),
           oauth: bergetOAuthAuth(),  // see #8
         },
         models,                     // or []  — verify
         fetchModels: (_ctx: RefreshModelsContext) => fetchBergetModels(),
         api: openAICompletionsApi(),
       }),
     );
   }
   ```
   **Open question to resolve at implementation time:** whether `createProvider` requires `await modelRuntime` or accepts the provider object directly through `pi.registerProvider(provider)`. Verified `registerProvider(provider: Provider): void` exists in 0.81.1 `ExtensionAPI` (line 986), so `pi.registerProvider(createProvider({...}))` is the call.
8. **The `OAuthAuth` object** — wrap `loginBerget`/`refreshBergetToken`/`toAuth`:
   ```ts
   const bergetOAuthAuth = (): OAuthAuth => ({
     name: 'Berget AI',
     loginLabel: 'Sign in with Berget Code',
     login: (interaction) => loginBerget(interaction),
     refresh: (credential, signal) => refreshBergetToken(credential, signal),
     toAuth: async (credential) => ({ apiKey: credential.access }),  // replaces getApiKey
   });
   ```

### Tests (6 files) — the bulk of the work

Verified per-file impact (grep of migrating symbols):
| File | Hits | Migration |
|---|---|---|
| `test/oauth.test.ts` | 49 | Rewrite mocks from `OAuthLoginCallbacks` (`onAuth`/`onPrompt`/`onProgress`/`onManualCodeInput`/`onSelect`) to `AuthInteraction` (`prompt`/`notify` discriminated unions). The `manual_code` prompt race replaces `onManualCodeInput`. |
| `test/oauth-callback-errors.test.ts` | 56 | Same auth-callback migration. **Most fragile** — these are the error-path race tests; they're what caught the WIP `_collectAuthCode` rewrite being questionable. Restoring `resolveManualCode` first (index.ts #5) minimises churn here. |
| `test/models.test.ts` | 18 | Rename `mapModelToProviderConfig` -> `mapBergetModelToModel`; add assertions for the new `api`/`provider`/`baseUrl` fields; `value: ProviderModelConfig` helpers become `Model<'openai-completions'>`. |
| `test/token-refresh.test.ts` | 19 | `refreshBergetToken` signature (add `signal` param, `OAuthCredential` return); `getApiKey` removed (no `getApiKey` in the new flow). |
| `test/token-validation.test.ts` | 5 | `exchangeToken`/`refreshBergetToken` now return `OAuthCredential` (add `type: 'oauth'` to expected + fixtures). |
| `test/extension.test.ts` | 3 | The factory call changes — the mock `ExtensionAPI.registerProvider` receives a `Provider` object, not `(name, config)`. Re-assert `id`, `baseUrl`, `auth`, `fetchModels` presence, `api: openAICompletionsApi()`. The PR #22 `refreshModels` test (line ~209) may be obsolete or transform into a `fetchModels` test. |
| `test/security-validation.test.ts` | 0 | **No changes** (uses only the unchanged PKCE / URL / HTML helpers). |

### Package metadata
- `package.json`: `devDependencies` `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `^0.80.10` -> `^0.81.0` (or `^0.81.1` to pin the verified version). Already done in the WIP `644cb4a` (`^0.81.1`).
- `README.md`: prerequisites floor `v0.80.x` -> `v0.81.x` (or state `^0.81.1`).

### Verification gate (in the worktree, against the freshly installed `^0.81.1`)
1. `npm install` (fresh — the WIP already has 0.81.1 in `node_modules`; a clean install reproduces).
2. `npx tsc --noEmit` — exit 0. **This is the gate that was RED at the WIP commit**; bringing it green is the central task.
3. `npm run lint` — clean (the `unicorn`/`sonarjs`/`tsdoc` rules apply to the new code too).
4. `npm test` — all previously-green tests pass after their migration (target: back to all-green; the PR #22 added one test that becomes `fetchModels`-shaped).

## Risks / open questions to resolve at implementation

1. **`createProvider` + `models` interaction.** Decide whether the factory passes `models: await fetchBergetModels()` (populated at startup for `/model` immediacy) with `fetchModels` as the refresh path, or `models: []` with `fetchModels` as the sole source. The v0.82.1 README's llama.cpp example uses `models: []` + `fetchModels`; the local-server example uses `models: [...]` without `fetchModels`. Confirm which gives both startup-immediacy and refresh. **Recommendation:** `models: await fetchBergetModels()` + `fetchModels: () => fetchBergetModels()` — matches the current "startup fetch for immediacy + refresh for updates" split PR #22 established.
2. **`apiKey` + `oauth` coexisting.** Confirm `envApiKeyAuth(name, ['BERGET_API_KEY'])` and a full `oauth` block on the same `ProviderAuth` work together — i.e. that pi uses the stored OAuth credential when present and falls back to the env key when not. The `ProviderAuth` type allows both; verify runtime preference with a manual smoke (`pi -e ./index.ts` + `/login berget`).
3. **The `_collectAuthCode` rewrite in the WIP.** Prefer restoring `resolveManualCode` under `AuthInteraction` (index.ts #5) over the WIP's `AbortController` rewrite — the existing race logic is what `oauth-callback-errors.test.ts` encodes, so keeping it reduces test churn and preserves verified behaviour.
4. **Scope guard.** The lazyparse `auth/oauth` shim and the local callback server are unchanged. Do not "improve" the PKCE, HTML, or socket-cleanup code — it's orthogonal to this migration and covered by `security-validation.test.ts`.

## Why this plan exists (do not delete)

PR #22 deferred persistence with a documented architectural reason. pi v0.81.0 removed the blocker, but only via a **rewrite**, not an additive change — this migration touches the provider registration, the OAuth subsystem, and all 6 auth/model test files. The first attempt reached a RED gate with partially-replaced, unverified race logic; **this document exists so the next attempt starts from verified type facts and a precise file-impact map instead of re-investigating.**
