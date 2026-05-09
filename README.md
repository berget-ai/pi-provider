# @bergetai/pi-provider-berget

Run Berget AI models inside Pi. Your inference data stays on Swedish infrastructure, within EU jurisdiction

```bash
pi install npm:@bergetai/pi-provider-berget
```

```bash
export BERGET_API_KEY=your-api-key   # or: /login berget
```

Select a model with `/model berget/<model-id>` or cycle with `Ctrl+P`.

## Who this is for

- You have a Berget AI account and want to use those models inside Pi
- You need inference data to remain in Swedish jurisdiction, not subject to the CLOUD Act or FISA 702
- You want Berget AI's model catalogue to appear in Pi automatically when new models are added

## Features

- **Automatic model discovery** — new models appear in Pi when Berget AI adds them. No manual tracking of model IDs
- **Two ways to authenticate** — API key for scripts and pay-as-you-go, or browser OAuth for Berget AI subscriptions
- **Cost tracking** — per-model pricing is pulled from the Berget AI API, so you know what each request costs
- **OpenAI-compatible streaming** — uses the same endpoint shape as OpenAI, so the switch is a base URL and an API key

## Prerequisites

- [Pi](https://pi.dev) v0.70.6 or later
- A [Berget AI](https://berget.ai) account

## Installation

**Via npm (recommended):**

```bash
pi install npm:@bergetai/pi-provider-berget
```

**Via git (for development or air-gapped installs):**

Globally:
```bash
git clone https://github.com/berget-ai/pi-provider-berget.git ~/.pi/agent/extensions/pi-provider-berget
cd ~/.pi/agent/extensions/pi-provider-berget
npm install
```

Project-local:
```bash
git clone https://github.com/berget-ai/pi-provider-berget.git .pi/extensions/pi-provider-berget
cd .pi/extensions/pi-provider-berget
npm install
```

Restart Pi or run `/reload` to load the extension.

## Authentication

This provider supports two authentication methods. API key authentication takes precedence when both are configured.

### API key (pay-as-you-go or programmatic)

Set your API key using one of the following methods.

**Environment variable (recommended):**

```bash
export BERGET_API_KEY=your-api-key
```

**`~/.pi/agent/auth.json`:**

```json
{
  "berget": {
    "type": "api_key",
    "key": "your-api-key"
  }
}
```

**`~/.pi/agent/models.json`:**

```json
{
  "providers": {
    "berget": {
      "baseUrl": "https://api.berget.ai/v1",
      "apiKey": "your-api-key"
    }
  }
}
```

> **Note:** Custom providers with OAuth configuration do not appear in `/login` under "Use an API key" for interactive entry. This is a known Pi limitation that affects all providers with dual authentication. Use the methods above instead.

### OAuth (Berget AI subscription)

For subscription-based accounts, authenticate interactively through your browser:

```
/login
```

Select **"Use a subscription"** and then **"Berget AI"** to start the OAuth flow:

1. Pi opens the Berget AI login page in your browser
2. You authenticate with your Berget AI credentials
3. Berget AI redirects back to a local callback server at `http://localhost:8787`
4. Pi captures the authorization code and exchanges it for tokens
5. Tokens are persisted in `~/.pi/agent/auth.json` and refreshed automatically

## Environment variables

| Variable                  | Default                      | Description                                                     |
| ------------------------- | ---------------------------- | --------------------------------------------------------------- |
| `BERGET_API_KEY`          | —                            | API key for direct authentication (takes precedence over OAuth) |
| `BERGET_INFERENCE_URL`    | `https://api.berget.ai/v1`   | Base URL for the inference API                                  |
| `BERGET_AUTH_URL`         | `https://keycloak.berget.ai` | Base URL for the Berget AI OAuth server                         |
| `BERGET_API_URL`          | `https://api.berget.ai`      | Base URL for the Berget AI API (model listing and token refresh) |
| `BERGET_OAUTH_TIMEOUT_MS` | `300000`                     | OAuth flow timeout in milliseconds (5 minutes default)          |

## Usage

After installation, Berget AI models are available in Pi. Select one with:

```
/model berget/<model-id>
```

For example:

```
/model berget/meta-llama/Llama-3.3-70B-Instruct
```

Or cycle through models with `Ctrl+P`. Models are prefixed with `berget/`.

List all available models from the command line:

```bash
pi --list-models
```

## Frequently asked questions

### Do I need a paid Berget AI account?

No. API key authentication works with any Berget AI account, including pay-as-you-go. OAuth authentication requires a Berget AI subscription.

### Where does my data go?

Inference requests run on Berget AI's Swedish infrastructure. Your data doesn't leave Swedish jurisdiction, which means it is not subject to the US CLOUD Act or FISA 702.

### Will new models appear automatically?

Yes. When Berget AI adds a new model to its API, it will appear in Pi after the next restart or `/reload`. You do not need to update the extension.

### Can I use both authentication methods?

Yes, though API key authentication takes precedence. If you configure both, Pi will use the API key. Remove the API key configuration to fall back to OAuth.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and architecture details.

## Licence

MIT
