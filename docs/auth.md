# Auth Implementation

## OAuth 2.0 + PKCE Flow

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BERGET_AUTH_URL` | `https://keycloak.berget.ai` | Keycloak base URL |
| `BERGET_API_URL` | `https://api.berget.ai` | Berget API base URL |
| `BERGET_INFERENCE_URL` | `https://api.berget.ai/v1` | OpenAI-compatible inference endpoint |
| `BERGET_OAUTH_TIMEOUT_MS` | `300000` (5 min) | Callback server & manual-input timeout |

### Authorization Code Flow

1. `loginBerget(callbacks)` generates a PKCE code verifier (128 random bytes) and challenges (SHA-256, base64url).
2. A local callback server is started on `127.0.0.1:8787`.
3. User completes login in a browser.
4. Keycloak redirects to `http://127.0.0.1:8787/callback` with an authorization code.
5. The code is exchanged for `access_token`, `refresh_token`, and `expires_in`.
6. Credentials are stored in `AuthStorage` as `{ type: 'oauth', access, refresh, expires }`.

## Known Limitations

1. **Callback server bind address**: The redirect URI uses `127.0.0.1` explicitly to avoid IPv6 dual-stack mismatch (`localhost` resolving to `::1` while the server binds `127.0.0.1`). Users on non-standard loopback configurations may need to adjust `CALLBACK_HOST`.

2. **Single retry attempt on auth error**: The stream interceptor (`processStreamWithRetry`) only performs **one** auth error retry. If the token refresh succeeds but the retried request also returns 401/403, the raw (non-intercepted) response is passed to the downstream consumer. This is a documented limitation — multi-attempt retry is not implemented.

3. **`isAuthenticationError` heuristic**: The interceptor inspects the first non-empty chunk for SSE `data:` framing and auth-specific keywords (`authentication_error`, `Unauthorized`, `invalid_token`, `Invalid token`). Very rare edge cases (e.g., an SSE frame split exactly across chunk boundaries with the auth keyword in the second chunk) may be missed. A future enhancement could buffer incomplete SSE lines.

4. **Model list validation**: If the Berget API returns an unexpected JSON shape (missing `models` array), the extension throws a clear error and fails to register. This is intentional — silent empty-model behavior could mask provider outages.

## Error Reference

| Error | Cause | Resolution |
|-------|-------|------------|
| `Port 8787 is already in use` | Another process holds the callback port | Close the conflicting app or wait until the previous OAuth flow completes |
| `Manual code input timed out` | `onManualCodeInput()` callback never resolved | Ensure the UI dialog resolves or rejects, or use the `onPrompt` fallback |
| `Authentication failed: ...` | Auth error in stream chunk and no refresh token available | Re-run OAuth login — the stored credentials may be expired or missing |
| `Invalid token response: ...` | Server returned unexpected JSON during token exchange or refresh | Check network/proxy; report to Berget if persistent |
| `Malformed model list response: ...` | `/v1/models/chat` returned non-array `models` or invalid JSON | Check `BERGET_API_URL`; may indicate API maintenance or outage |

## Function Reference

### `refreshBergetAuthToken(apiKey: string)`

Refreshes the access token using the stored OAuth credentials.

- `apiKey` is compared against `cred.access` to detect concurrent refreshes.
- Returns `null` if no OAuth credentials are stored.
- Returns `{ apiKey, newCredentials }` if a cached unexpired token exists and differs from the input.
- Throws `Token refresh failed: <status>` on HTTP error.
- Throws `Invalid token response: ...` if the JSON shape is unexpected.
