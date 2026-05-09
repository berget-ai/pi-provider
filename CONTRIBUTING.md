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

On startup, the extension fetches available chat models from `GET https://api.berget.ai/v1/models/chat`. Each model is mapped to Pi's `ProviderModelConfig`, including:

- Per-million-token pricing (input / output)
- Context window size
- Compatibility flags (for example, `supportsDeveloperRole: false`)

### 3. Provider registration

The extension calls `pi.registerProvider("berget", ...)` with:

- `api`: `"openai-completions"` for OpenAI-compatible streaming
- `baseUrl`: the Berget inference API endpoint
- `apiKey`: `"BERGET_API_KEY"` (the environment variable name, not a literal key)
- `oauth`: configuration for `/login` browser-based authentication

### 4. OAuth implementation

The provider implements a PKCE-based authorization code flow:

- **`loginBerget`** — opens the Berget AI login page in the user's browser, starts a local callback server on `http://localhost:8787`, captures the authorization code, and exchanges it for access and refresh tokens
- **`refreshBergetToken`** — refreshes expired tokens via `POST https://api.berget.ai/v1/auth/refresh` using the stored refresh token; the new access token is used as the Bearer token for inference requests

Credentials are persisted in `~/.pi/agent/auth.json` and refreshed automatically before each inference request if they have expired.

## Resources

- [Pi Extensions Documentation](https://pi.dev/docs/latest/extensions)
- [Pi Custom Providers Documentation](https://pi.dev/docs/latest/custom-provider)
- [Pi on GitHub](https://github.com/earendil-works/pi)
