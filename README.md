# Pi extension for Berget AI

Run [Berget AI](https://berget.ai) models inside [Pi](https://pi.dev).

## Prerequisites

- [Pi](https://pi.dev) v0.81.x or later
- A [Berget AI](https://berget.ai) account

## Installation

```bash
pi install npm:@bergetai/pi-provider
```

Restart Pi or run `/reload` to load the extension.

## Authentication

This provider supports two authentication methods. API key authentication takes precedence when both are configured.

### Using an API key

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

### Using a Berget Code plan

If you have a Berget Code plan, authenticate interactively through your browser:

```
/login
```

Select **"Use a subscription"** and then **"Berget AI"**.

## Usage

Once authenticated, Berget AI models are available in Pi. Select one with:

```
/model
```

Or cycle through models with `Ctrl+P`. Models are prefixed with `berget/`.

List all available models from the command line:

```bash
pi --list-models
```

### Classifiers (System One)

The provider also registers two [System One](https://docs.berget.ai) classifier models — `laya-latest` (multilingual) and `systemone` (Qwen3.5 2B) — that answer typed questions (`bool`, `choice`, `score`) about an application state in a single pass. They don't appear in `pi --list-models` (that lists chat models only); extensions reach them through the model registry:

```ts
const model = ctx.modelRegistry.getModelOfType('classifier', 'berget', 'laya-latest');
const result = await ctx.modelRegistry.classify(model!, {
  state: { ticket: 'double-charge' },
  questions: {
    refund: {
      type: 'bool',
      instructions: 'Is the customer asking for money back?',
      criteria: { true: 'wants refund', false: 'something else' },
    },
  },
});
```

Codemode scripts use the same surface — `await models.getModelOfType('classifier', 'berget', 'laya-latest')` then `await models.classify(model, context)` (note the `await`s in codemode). `state` must be an object and the question types are the public `bool`/`choice`/`score`; toggle them via the codemode `--tools` flag. Both models are in eval state upstream and billed at €0.042/M input tokens (output free).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and architecture details.

## Licence

MIT
