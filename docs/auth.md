# Auth Implementation

## OAuth 2.0 + PKCE Flow

### Configuration

| Variable                  | Default                      | Description                            |
| ------------------------- | ---------------------------- | -------------------------------------- |
| `BERGET_AUTH_URL`         | `https://keycloak.berget.ai` | Keycloak base URL                      |
| `BERGET_API_URL`          | `https://api.berget.ai`      | Berget API base URL                    |
| `BERGET_INFERENCE_URL`    | `https://api.berget.ai/v1`   | OpenAI-compatible inference endpoint   |
| `BERGET_OAUTH_TIMEOUT_MS` | `300000` (5 min)             | Callback server & manual-input timeout |

### Authorization Code Flow

1. `loginBerget(callbacks)` generates a PKCE code verifier (128 random bytes) and challenges (SHA-256, base64url).
2. A local callback server is started on `127.0.0.1:8787`.
3. User completes login in a browser.
4. Keycloak redirects to `http://127.0.0.1:8787/callback` with an authorization code.
5. The code is exchanged for `access_token`, `refresh_token`, and `expires_in`.
6. Credentials are stored in `AuthStorage` as `{ type: 'oauth', access, refresh, expires }`.

## Known Limitations

1. **Callback server bind address**: The redirect URI uses `127.0.0.1` explicitly to avoid IPv6 dual-stack mismatch (`localhost` resolving to `::1` while the server binds `127.0.0.1`). Users on non-standard loopback configurations may need to adjust `CALLBACK_HOST`.

2. **Model list validation**: If the Berget API returns an unexpected JSON shape (missing `models` array), the extension throws a clear error and fails to register. This is intentional — silent empty-model behavior could mask provider outages.

## Error Reference

| Error                                | Cause                                                            | Resolution                                                                |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Port 8787 is already in use`        | Another process holds the callback port                          | Close the conflicting app or wait until the previous OAuth flow completes |
| `Manual code input timed out`        | `onManualCodeInput()` callback never resolved                    | Ensure the UI dialog resolves or rejects, or use the `onPrompt` fallback  |
| `Invalid token response: ...`        | Server returned unexpected JSON during token exchange or refresh | Check network/proxy; report to Berget if persistent                       |
| `Malformed model list response: ...` | `/v1/models/chat` returned non-array `models` or invalid JSON    | Check `BERGET_API_URL`; may indicate API maintenance or outage            |
