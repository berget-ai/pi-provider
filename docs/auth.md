# Auth implementation

How the Berget provider authenticates users via OAuth 2.0 authorisation code + PKCE against Keycloak — covering configuration, the authorisation flow, known limitations, and error reference.

## OAuth 2.0 + PKCE flow

### Configuration

| Variable                  | Default                      | Description                                             |
| ------------------------- | ---------------------------- | ------------------------------------------------------- |
| `BERGET_AUTH_URL`         | `https://keycloak.berget.ai` | Keycloak base URL                                       |
| `BERGET_API_URL`          | `https://api.berget.ai`      | Berget API base URL                                     |
| `BERGET_OAUTH_TIMEOUT_MS` | `300000` (5 min)             | Callback server & manual-input timeout                  |
| `BERGET_INFERENCE_URL`    | `https://api.berget.ai/v1`   | Inference endpoint base URL; not used by the OAuth flow |

```bash
export BERGET_AUTH_URL=https://keycloak.berget.ai
export BERGET_API_URL=https://api.berget.ai
export BERGET_INFERENCE_URL=https://api.berget.ai/v1
export BERGET_OAUTH_TIMEOUT_MS=300000
```

### Authorisation code flow

1. `loginBerget(callbacks)` generates a PKCE code verifier from 96 random bytes (base64url-encoded to a 128-character verifier, within RFC 7636's 43–128-character range) and derives the code challenge (SHA-256, base64url).
2. A local callback server is started on `127.0.0.1:8787`.
3. User completes login in a browser.
4. Keycloak redirects to `http://127.0.0.1:8787/callback` with an authorisation code.
5. The code is exchanged for `access_token`, `refresh_token`, and `expires_in`.
6. OAuth credentials (access token, refresh token, and expiry timestamp) are stored locally by the SDK.

**State (CSRF protection).** Each flow generates a random `state` value, sent in the authorisation request and validated on the callback. If the callback's `state` does not match, the callback server rejects the response (see "State mismatch" in the error reference) and the flow falls through to manual code entry via `onPrompt`.

**Scopes.** The authorisation request uses `openid email profile offline_access`. The `offline_access` scope is what yields the `refresh_token` that the token-refresh path depends on.

## Known limitations

1. **Callback server bind address**: The redirect URI uses `127.0.0.1` explicitly to avoid IPv6 dual-stack mismatch (`localhost` resolving to `::1` while the server binds `127.0.0.1`). The bind address is hardcoded to `127.0.0.1` (the `CALLBACK_HOST` constant in `index.ts`) and is not configurable at runtime. Users on non-standard loopback configurations must edit the source.

2. **Model list validation**: If the Berget API returns an unexpected JSON shape (missing `models` array), the extension throws a clear error and fails to register. This is intentional — silent empty-model behaviour could mask provider outages.

## Error reference

| Error                                                                                                  | Cause                                                                                                        | Resolution                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Port 8787 is already in use`                                                                          | Another process holds the callback port                                                                      | Close the conflicting app or wait until the previous OAuth flow completes                                                           |
| `Failed to fetch models: <status> <statusText>`                                                        | `/v1/models/chat` returned a non-2xx response during extension registration                                  | Check `BERGET_API_URL`; may indicate API maintenance or outage                                                                      |
| `Malformed model list response: ...`                                                                   | `/v1/models/chat` returned a 2xx response with an unexpected JSON shape (missing `models` array)             | Check `BERGET_API_URL`; may indicate API maintenance or outage                                                                      |
| `Missing authorization code`                                                                           | No code was received from the callback or the `onPrompt` manual entry                                        | Retry login; confirm the browser reached `http://127.0.0.1:8787/callback`                                                           |
| `Token exchange failed: <status> <body>`                                                               | Keycloak returned a non-2xx response during the authorisation-code exchange                                  | Check `BERGET_AUTH_URL` and network/proxy; retry                                                                                    |
| `Invalid token response: expected { access_token: string, expires_in: number, refresh_token: string }` | Keycloak token endpoint returned unexpected JSON during login                                                | Check `BERGET_AUTH_URL`; report to Berget if persistent                                                                             |
| `Token refresh failed: <status> <body>`                                                                | Berget `/v1/auth/refresh` returned a non-2xx response during refresh                                         | Token may be revoked or expired; re-login via `/login`                                                                              |
| `Invalid token response: expected { token: string, expires_in: number, refresh_token?: string }`       | Berget `/v1/auth/refresh` returned unexpected JSON during refresh                                            | Check `BERGET_API_URL`; may indicate API maintenance                                                                                |
| Browser: "Authentication Failed: `<error>`"                                                            | Keycloak redirected to the callback with an `error` param (e.g. `access_denied` when the user cancels login) | The user declined login or the auth server rejected the request; retry. The flow falls through to manual code entry via `onPrompt`. |
| Browser: "State mismatch. Please try again."                                                           | The callback `state` did not match the expected value (CSRF guard tripped)                                   | Retry login                                                                                                                         |
