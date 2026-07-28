# Migration plan: `createProvider()` full-provider form + `ModelsStore` persistence

> **Status:** WIP scratch branch `feat/full-provider-persistence` (commit `644cb4a`, local-only, **DO NOT MERGE**). This document captures the verified `Step 0` API investigation so the next attempt does not re-investigate. See the `impl-plan` section for the ordered work.

## Goal

Deliver the **`context.store` model-catalog persistence** that was deferred in PR #22. The deferred work was blocked at the `^0.80.10` SDK because `refreshModels(context)` returns `ProviderModelConfig[]` while `context.store` holds pi-ai `Model<Api>[]`, and pi does not export the `ProviderModelConfig -> Model` converter (`applyExtension` is internal).

**pi v0.81.0 ("Full provider extensions") removes that blocker:** extensions can register a _complete pi-ai `Provider`_ via `createProvider()`, with native `auth`, `fetchModels` (dynamic discovery that `createProvider` + `ModelsStore` persist in the `Model[]` shape — so the conversion gap disappears), `filterModels`, and `stream`/`streamSimple`. Quoting the v0.82.1 docs: _"The object form accepts a complete pi-ai `Provider`, including native `auth`, `getModels`, `refreshModels`, `filterModels`, `stream`, and `streamSimple` behavior."_

This is **only achievable on `>= v0.81.0`** — the object-form `registerProvider(provider: Provider)` overload is the gating v0.81.0 addition (verified: absent in installed 0.80.10's `ExtensionAPI`; present at line 986 of `types.d.ts` in installed 0.81.1). The legacy `registerProvider(name, ProviderConfig)` form (what PR #22 uses) still works on 0.81.x via the internal `adaptOAuth` adapter, so a floor bump alone is safe — but it does **not** deliver persistence. Persistence requires the full rewrite.

## Verified Step 0 findings — the new API surface

All type shapes below were verified against the **installed `pi-ai@0.81.1` / `pi-coding-agent@0.81.1`** (matching v0.82.1's docs; v0.81.0 is the minimum).

> **Note on finding these symbols:** `createProvider` lives in `models.ts` and `envApiKeyAuth` in `auth/helpers.ts`; the root `index.d.ts` reaches them via `export * from "./models.ts"` / `"./auth/helpers.ts"` (lines 21/17). A literal `grep createProvider index.d.ts` will therefore return nothing and wrongly suggest the symbol is missing — resolve with `tsc`, not `grep`.

### `createProvider(input: CreateProviderOptions): Provider<TApi>` — from `@earendil-works/pi-ai` (root)

```ts
export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string; // required — "berget"
  name?: string; // "Berget AI"
  baseUrl?: string; // getInferenceUrl()
  headers?: ProviderHeaders;
  auth: ProviderAuth; // REQUIRED — { apiKey?, oauth? }, >=1 present
  models: readonly Model<TApi>[]; // REQUIRED — baseline list; [] for purely dynamic
  fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
  filterModels?: (models, credential) => readonly Model<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>; // REQUIRED
}
```

`createProvider` + `fetchModels` own persistence automatically — _"createProvider restores/persists it through `ModelsStore`"_ (pi-ai `models.d.ts` doc comment). **No manual `store.write` is needed in the extension**, unlike the legacy `refreshModels(context)` where the extension was _expected_ to do store I/O (and couldn't, due to the shape gap).

### `ProviderAuth` — required `auth` field

```ts
export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
} // at least one of apiKey/oauth must be present
```

For Berget (supports env-key _and_ OAuth), set both: `apiKey: envApiKeyAuth('Berget AI', ['BERGET_API_KEY'])` and `oauth: { … AuthInteraction form … }`. `envApiKeyAuth` is exported from `@earendil-works/pi-ai` root (re-exported from `auth/helpers.ts`).

### `OAuthAuth` — the OAuth migration (replaces the legacy `oauth: { login, refreshToken, getApiKey }` block)

```ts
export interface OAuthAuth {
  name: string; // was oauth.name
  loginLabel?: string; // NEW — "Sign in with..." for the login selector
  login(interaction: AuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>; // throws on failure
  toAuth(credential: OAuthCredential): Promise<ModelAuth>; // NEW — replaces getApiKey(cred) => cred.access
}
```

**Key behavioural change:** `Models` owns the locked refresh — it calls `refresh` under the credential-store lock and `toAuth` derives request auth from whatever credential is stored. The extension no longer hand-rolls expiry-check / reuse-already-rotated-token logic (it currently doesn't, post-PR-#16, so this is a simplification).

### `AuthInteraction` — replaces `OAuthLoginCallbacks`

```ts
export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>; // discriminates: text | secret | select | manual_code
  notify(event: AuthEvent): void; // discriminates: info | auth_url | device_code | progress
}
```

#### Callback mapping (legacy `OAuthLoginCallbacks` -> new `AuthInteraction`)

| Legacy                                                                             | New                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callbacks.onAuth({ url, instructions })`                                          | `interaction.notify({ type: 'auth_url', url, instructions })`                                                                                                                                                                    |
| `callbacks.onDeviceCode({ userCode, verificationUri, … })`                         | `interaction.notify({ type: 'device_code', userCode, verificationUri, … })`                                                                                                                                                      |
| `callbacks.onProgress?.(message)`                                                  | `interaction.notify({ type: 'progress', message })`                                                                                                                                                                              |
| `callbacks.onPrompt({ message, placeholder })` -> `Promise<string>`                | `interaction.prompt({ type: 'text', message, placeholder })` -> `Promise<string>`                                                                                                                                                |
| `callbacks.onManualCodeInput?.()` -> `Promise<string>` (races the callback server) | `interaction.prompt({ type: 'manual_code', message, placeholder, signal })` — `message` is **required** on every prompt variant including `manual_code`; the per-prompt `signal` aborts the prompt when the callback server wins |
| `callbacks.onSelect?.({ message, options })`                                       | `interaction.prompt({ type: 'select', message, options })`                                                                                                                                                                       |
| `callbacks.signal?`                                                                | `interaction.signal?`                                                                                                                                                                                                            |

### `OAuthCredential` vs `OAuthCredentials`

```ts
export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}
export interface OAuthCredential extends OAuthCredentials {
  type: 'oauth';
} // add type: 'oauth'
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
5. **`_collectAuthCode` — a rewrite either way (see Risks #3 for the verified detail).** The WIP (`644cb4a`) rewrote `_collectAuthCode` to an `AbortController` + single `manual_code` prompt design that never calls `resolveManualCode`, leaving `resolveManualCode` as dead code (the 3 tests at `oauth-callback-errors.test.ts:94/121/163` import it by name). Two options, **both rewrites**:
   - **Option B (recommended, port the race):** restore `resolveManualCode`'s `Promise.race([waitForCode, manualPromise, timeout])` structure under an `AuthInteraction` signature — `onManualCodeInput()` -> `interaction.prompt({ type: 'manual_code', message: '…', placeholder: '…', signal: perPromptSignal })` (**`message` is required on every prompt variant, including `manual_code`**), keep `getOAuthTimeoutMs()` timeout. Preserves the verified timeout/unhandled-rejection edge cases the 3 tests encode.
   - **Option A (delete the dead code):** keep the WIP's `_collectAuthCode`, delete `resolveManualCode`, and delete/convert the 3 tests. Loses coverage of the late-manual-rejection contract.
     The choice is made in Risks #3; either way the 4 `_collectAuthCode` tests (`:23/48/69/~213`) rewrite regardless (they mock `OAuthLoginCallbacks`).
6. **`refreshBergetToken(credential: OAuthCredential, signal?): Promise<OAuthCredential>`** — signature change: add `signal?: AbortSignal` param (thread into the `fetch`); add `type: 'oauth'` to the returned object; declare return `Promise<OAuthCredential>`. (WIP changed the return type of `exchangeToken`; do the same here.)
7. **Factory — wire `createProvider`** (NOT done in WIP; `644cb4a` line 807 still has the legacy `pi.registerProvider('berget', { oauth: { login: loginBerget, … } })` block). Per Risks #1, pass a **populated `models`** to preserve unauthenticated `/model` visibility (the `models: []` + `fetchModels`-only form leaves the catalog empty for logged-out users because `Models.refresh` early-returns when no credential resolves):
   ```ts
   export default async function (pi: ExtensionAPI): Promise<void> {
     // Unconditional startup fetch preserves `pi --list-models` visibility
     // for unauthenticated users (matches current 0.80.10 behaviour). A throw
     // here aborts registration, same as today.
     const models = await fetchBergetModels();
     pi.registerProvider(
       createProvider({
         id: 'berget',
         name: 'Berget AI',
         baseUrl: getInferenceUrl(),
         auth: {
           apiKey: envApiKeyAuth('Berget AI', ['BERGET_API_KEY']),
           oauth: bergetOAuthAuth(), // see #8
         },
         models, // populated — see Risks #1
         fetchModels: (_ctx: RefreshModelsContext) => fetchBergetModels(),
         api: openAICompletionsApi(),
       }),
     );
   }
   ```
   **Verified:** `pi.registerProvider(createProvider({...}))` is the call — `registerProvider(provider: Provider): void` exists at `types.d.ts:986`, and the runtime dispatches the object form via `loader.js:303` -> `runtime.registerNativeProvider` -> `runner.js:211` `modelRegistry.registerProvider(provider)`. No `await modelRuntime` wrap is needed.
8. **The `OAuthAuth` object** — wrap `loginBerget`/`refreshBergetToken`/`toAuth`:
   ```ts
   const bergetOAuthAuth = (): OAuthAuth => ({
     name: 'Berget AI',
     loginLabel: 'Sign in with Berget Code',
     login: (interaction) => loginBerget(interaction),
     refresh: (credential, signal) => refreshBergetToken(credential, signal),
     toAuth: async (credential) => ({ apiKey: credential.access }), // replaces getApiKey
   });
   ```

### Tests (6 files) — the bulk of the work

Verified per-file impact (grep of migrating symbols):
| File | Hits | Migration |
|---|---|---|
| `test/oauth.test.ts` | 49 | Rewrite mocks from `OAuthLoginCallbacks` (`onAuth`/`onPrompt`/`onProgress`/`onManualCodeInput`/`onSelect`) to `AuthInteraction` (`prompt`/`notify` discriminated unions). The `manual_code` prompt race replaces `onManualCodeInput`. |
| `test/oauth-callback-errors.test.ts` | 56 | Same auth-callback migration. **Most fragile** — the error-path race tests. **7 tests total:** 4 `_collectAuthCode` tests (`:23/48/69/~213`) rewrite regardless (mock `OAuthLoginCallbacks`); 3 `resolveManualCode` tests (`:94/121/163`) import `resolveManualCode` by name and encode the timeout / late-rejection contracts. If Risks #3 Option B (port the race) is chosen, the 3 stay close to current intent; if Option A (delete), they go too. **Do not assume "restore first minimises churn"** — there is no minimal path (see Risks #3). |
| `test/models.test.ts` | 18 | Rename `mapModelToProviderConfig` -> `mapBergetModelToModel`; add assertions for the new `api`/`provider`/`baseUrl` fields; `value: ProviderModelConfig` helpers become `Model<'openai-completions'>`. |
| `test/token-refresh.test.ts` | 19 | `refreshBergetToken` signature (add `signal` param, `OAuthCredential` return); `getApiKey` removed (no `getApiKey` in the new flow). |
| `test/token-validation.test.ts` | 5 | `exchangeToken`/`refreshBergetToken` now return `OAuthCredential` (add `type: 'oauth'` to expected + fixtures). |
| `test/extension.test.ts` | 3 | The factory call changes — the mock `ExtensionAPI.registerProvider` receives a `Provider` object, not `(name, config)`. Re-assert `id`, `baseUrl`, `auth` (with `apiKey`+`oauth`), `typeof getModels === 'function'`, `typeof refreshModels === 'function'`, `api: openAICompletionsApi()`. The PR #22 `refreshModels` test (`:208`) **transforms, not deletes** (see Risks #5): assert `provider.refreshModels({ store: mockStore, … })` calls `fetchBergetModels` and writes via `mockStore.write`. |
| `test/security-validation.test.ts` | 0 | **No changes** (uses only the unchanged PKCE / URL / HTML helpers). |

### Package metadata

- `package.json`: `devDependencies` `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `^0.80.10` -> `^0.81.0` (or `^0.81.1` to pin the verified version). Already done in the WIP `644cb4a` (`^0.81.1`).
- `README.md`: prerequisites floor `v0.80.x` -> `v0.81.x` (or state `^0.81.1`).

### Verification gate (in the worktree, against the freshly installed `^0.81.1`)

1. `npm install` (fresh — the WIP already has 0.81.1 in `node_modules`; a clean install reproduces).
2. `npx tsc --noEmit` — exit 0. **This is the gate that was RED at the WIP commit**; bringing it green is the central task.
3. `npm run lint` — clean (the `unicorn`/`sonarjs`/`tsdoc` rules apply to the new code too).
4. `npm test` — all previously-green tests pass after their migration (target: back to all-green; the PR #22 `refreshModels` test transforms per Risks #5).
5. **Runtime smoke (the gate the unit tests can't cover — see Risks #1, #2, #4).** Against a real `pi` binary on the bumped floor:
   - (a) **Unauthenticated visibility:** with no stored credential and no `BERGET_API_KEY`, `pi --list-models` still shows the Berget catalog (validates the `models:[populated]` decision — Risks #1).
   - (b) **Offline restart from store:** after `/login berget` and a full catalog refresh, `pi --list-models` with network blocked still lists the catalog from `context.store` (validates the persistence lifecycle — Risks #2).
   - (c) **Env-vs-OAuth precedence:** with a stored OAuth credential AND `BERGET_API_KEY` set, observe which auth the inference request uses (validates Risks #4).

## Risks / open questions to resolve at implementation

All items below were investigated against the installed 0.81.1 source during this review (see commit history of this file for the investigation diff). **Verified** = confirmed in SDK source; **open** = needs a runtime smoke.

1. **(Verified) `models: []` causes a `/model` regression for unauthenticated users — keep `models: [await fetchBergetModels()]`.** `Models.refresh()` per-provider early-returns when `resolveRefreshCredential()` returns `undefined` (`pi-ai/dist/models.js:88-89`), and the agent calls it at startup with `allowNetwork: false` (`agent-session-services.js:97`). With `createProvider({ models: [], fetchModels })`, an unauthenticated user (no stored OAuth credential, no `BERGET_API_KEY` env) therefore gets `refreshModels` **never called**, so `dynamicModels` stays `[]` and `getModels()` returns the empty baseline → **`pi --list-models` shows no Berget models**. Today (main, 0.80.10) the startup fetch at `index.ts:765` is **unconditional** (no auth gate), so the full catalog is visible before login. **Decision: pass `models: await fetchBergetModels()` (populated) + `fetchModels: () => fetchBergetModels()` (refresh)** to preserve unauthenticated visibility. NB the `currentModels()` merge overwrites baseline entries by id and appends new dynamic ids, so passing the _same_ models in both buckets does **not** double-list (verified). The only subtlety: a model _removed_ upstream lingers in the baseline until the next `createProvider` rebuild (acceptable — refresh still surfaces removals to `dynamicModels`, and the merged view hides baseline entries that a dynamic fetch replaced and retained).

- **Task for the implementer:** confirm the startup fetch failure mode — today a failed `fetchBergetModels()` throws and aborts registration. With `createProvider`, `models` is required, so a failed startup fetch either (a) still throws pre-registration (current behaviour, safe) or (b) must fall back to `models: []` + rely on `fetchModels`. Prefer (a) to keep parity.

2. **(Verified) The `fetchModels` persistence lifecycle has real precedent** in the host: `pi-coding-agent`'s `withRemoteCatalog` (`dist/core/remote-catalog-provider.js`) uses the identical `store.read → (cache check) → fetch → store.write` shape, including `context.store.write()` on 404/501 and on success (lines 75, 79, 92). So the read/store/write lifecycle `createProvider` performs for `fetchModels` is exercised in production for the built-in catalog overlay. **My earlier review overstated this risk as "zero precedent"; corrected.** Remaining open question:

- **(open) Timing of `createProvider`'s first `refreshModels` call for a `models:[populated]` provider.** With a populated `models` baseline AND a logged-in user, does the agent call `refresh` eagerly so `fetchModels` updates the catalog quickly, or lazily so the baseline serves until a stale-cache trigger? Verify with a runtime smoke (`pi update --models` after login).

3. **(Verified) The `_collectAuthCode` design is a rewrite either way — frame it honestly.** Contrary to this doc's earlier framing, "restoring `resolveManualCode`" is itself a rewrite: under `AuthInteraction` there is no opt-in (the legacy `if (!callbacks.onManualCodeInput) return null` guard has no analogue — `manual_code` is always available via `prompt`). The verified state of the WIP (`644cb4a`) is: `_collectAuthCode` was rewritten to an `AbortController` + single `manual_code` prompt design that **never calls `resolveManualCode`**, and `resolveManualCode` is left as dead code (still `OAuthLoginCallbacks`, imported by name from `test/oauth-callback-errors.test.ts:5`). The choice is:

- **Option A (rewrite-in-place):** keep the WIP's `AbortController` design, **delete the now-dead `resolveManualCode`** (the 3 tests that import it by name — lines 94/121/163 — must be deleted or converted to `_collectAuthCode`-level tests). The unhandled-rejection contract test (#121) becomes trivial (no dangling manual promise exists to reject late), so its _purpose_ is lost unless re-expressed against `_collectAuthCode`.
- **Option B (port the race):** restore `resolveManualCode`'s `Promise.race([waitForCode, manualPromise, timeout])` structure under `AuthInteraction` signature (manual-input via `interaction.prompt({type:'manual_code', message, signal})`), keeping the 3 tests' assertions close to their current intent. More test churn to set up, but preserves the verified timeout/unhandled-rejection contracts.
- **Recommendation: Option B** — the 3 tests encode real edge cases (timeout cancels `cancelWait`; late manual rejection doesn't surface as unhandled) that Option A discards. Either way, the 4 `_collectAuthCode` tests (lines 23/48/69/~213) rewrite regardless (they mock `OAuthLoginCallbacks`). Closed as a design decision here; do **not** treat #5 in the impl-plan as "minimal restoration."

4. **(Verified) `apiKey` + `oauth` coexisting.** The `ProviderAuth` type allows both (`{ apiKey?: ApiKeyAuth; oauth?: OAuthAuth }`). `envApiKeyAuth` resolves from env lazily, `oauth.toAuth` from a stored credential. `(open)` confirm runtime preference: does pi prefer a stored OAuth credential over an ambient env key? Verify with a manual smoke (`pi -e ./index.ts` + `/login berget` then without logging out set `BERGET_API_KEY` and observe which is used).

5. **(Verified) The PR #22 `refreshModels` test must transform, not delete.** `test/extension.test.ts:208` asserts `capturedConfig!.refreshModels!()` on a captured legacy `ProviderConfig`. Under `createProvider`, there is no captured `ProviderConfig` — the mock `ExtensionAPI.registerProvider` receives a `Provider` object instead. The test should transform to: assert `createProvider`'s returned `Provider` has `typeof getModels === 'function'`, `typeof refreshModels === 'function'`, and that `refreshModels({ store: mockStore, ... })` calls `fetchBergetModels` and writes via `mockStore.write`. This preserves PR #22's live-discovery regression coverage (which must not be lost). The factory test at line 21 (`registerProvider is called with correct config`) re-asserts `id`/`baseUrl`/`auth`/`api` on the `Provider`.
6. **(Verified) `token-refresh.test.ts` churn is signature-only, not behavioural.** Its `expiredCreds()` helper returns `OAuthCredentials` (no `type` field) and assertions touch only `.access`/`.refresh`/`.expires` — they do **not** assert `.type`. So adding `type: 'oauth'` to `refreshBergetToken`'s return breaks no assertions; the required edits are: (a) helper return type `OAuthCredentials` → `OAuthCredential` (and add `type: 'oauth'` to its object), (b) `refreshBergetToken` param/return type, (c) the `signal?: AbortSignal` arg (most of the 19 hits are call sites unaffected by the arg since it's optional). The `getApiKey` references in this file are to legacy `oauth.getApiKey` text in comments, not live code post-migration.
7. **Scope guard.** The PKCE, URL-builder, base64, HTML, and callback-server socket-cleanup code is unchanged by this migration and covered by `test/security-validation.test.ts` (0 hits). Do not "improve" it. The only security-relevant change is that the `AuthInteraction`-form `login`/`manual_code` path must still guarantee the loopback server is closed in `finally` (already true in both design options above).

## Why this plan exists (do not delete)

PR #22 deferred persistence with a documented architectural reason. pi v0.81.0 removed the blocker, but only via a **rewrite**, not an additive change — this migration touches the provider registration, the OAuth subsystem, and all 6 auth/model test files. The first attempt reached a RED gate with partially-replaced, unverified race logic; **this document exists so the next attempt starts from verified type facts and a precise file-impact map instead of re-investigating.**
