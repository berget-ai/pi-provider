# Contributing to @bergetai/pi-provider

Thank you for your interest in contributing! This document covers development setup, testing, and how the extension works.

## Development setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/berget-ai/pi-provider.git
cd pi-provider
npm install
```

## Testing

Run the test suite:

```bash
npm test
```

For quick manual testing, load the extension directly without installing it:

```bash
pi -e ./index.ts
```

> **Tip:** For iterative development, place the extension in `~/.pi/agent/extensions/pi-provider` or `.pi/extensions/pi-provider` and use `/reload` in Pi to pick up changes after each edit.

## Architecture

The extension follows the [async factory function](https://pi.dev/docs/latest/extensions#async-factory-functions) pattern recommended by the Pi documentation. This means Pi awaits the extension's default export before continuing startup, so models are available for `pi --list-models` and interactive use immediately.

### 1. Async factory function

The extension exports an `async` default function. Pi awaits it during startup, so all initialization (including remote model discovery) completes before the first prompt or model listing.

### 2. Model discovery

On startup, the extension fetches available chat models from `GET https://api.berget.ai/v1/models/chat`. Each model is mapped to a pi-ai `Model<'openai-completions'>`, including:

- Per-million-token pricing (input / output)
- Context window size
- Compatibility flags (for example, `supportsDeveloperRole: false`)
- The fixed provider identity (`api: 'openai-completions'`, `provider: 'berget'`, `baseUrl`)

The same `fetchBergetModels()` call is also wired as `createProvider`'s `fetchModels`, so `pi update --models` re-runs discovery and the result is persisted across sessions through Pi's `ModelsStore`.

### 3. Provider registration

The extension builds a complete pi-ai `Provider` via `createProvider()` and registers it with the object-form `pi.registerProvider(provider)`:

- `id`: `"berget"`, `baseUrl`: the Berget inference API endpoint
- `auth`: both `apiKey` (`envApiKeyAuth` reading `$BERGET_API_KEY`) and `oauth` (`/login` browser-based authentication)
- `models`: the startup fetch catalog (so `pi --list-models` is populated even before login)
- `fetchModels`: the `ModelsStore`-persisted refresh path
- `api`: `openAICompletionsApi()` for OpenAI-compatible streaming

### 4. OAuth implementation

The provider implements a PKCE-based authorization code flow:

- **`loginBerget`** — opens the Berget AI login page in the user's browser, starts a local callback server on `http://127.0.0.1:8787`, captures the authorization code, and exchanges it for access and refresh tokens
- **`refreshBergetToken`** — refreshes expired tokens via `POST https://api.berget.ai/v1/auth/refresh` using the stored refresh token; the new access token is used as the Bearer token for inference requests

Credentials are persisted in `~/.pi/agent/auth.json` and refreshed automatically before each inference request if they have expired.

## Implementation history: full-provider form + catalog persistence

The extension uses Pi's v0.81.0 "Full provider extensions" (`createProvider()` + the object-form `registerProvider(provider)`) to register a complete pi-ai `Provider`. This delivers `ModelsStore`-persisted catalog refresh (`fetchModels`), which was previously blocked: the legacy `registerProvider(name, ProviderConfig)` form's `refreshModels` returned `ProviderModelConfig[]` while the store holds pi-ai `Model[]`, and Pi did not export the converter. The migration also moved OAuth from the legacy `OAuthLoginCallbacks` callbacks to `AuthInteraction` (discriminated `prompt`/`notify`). See [`docs/persistence-migration.md`](./docs/persistence-migration.md) for the verified v0.81.x API surface and the design decisions (the `models:[populated]` vs `[]` tradeoff, the `manual_code` race port, the PR #22 test transformation).

## Resources

- [Pi Extensions Documentation](https://pi.dev/docs/latest/extensions)
- [Pi Custom Providers Documentation](https://pi.dev/docs/latest/custom-provider)
- [Pi on GitHub](https://github.com/earendil-works/pi)
