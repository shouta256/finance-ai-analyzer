# Cognito Authentication Flow

Safepocket uses Amazon Cognito (Authorization Code flow) for production authentication. The Next.js BFF orchestrates the browser experience, and native clients interact with the ledger service or Lambda facade to exchange authorization codes for tokens.

## Configuration Reference

### Backend (`apps/ledger-svc`)
- `SAFEPOCKET_USE_COGNITO=true`
- `COGNITO_DOMAIN=https://<your-domain>.auth.<region>.amazoncognito.com`
- `COGNITO_CLIENT_ID_WEB=<hosted-ui web client>`
- `COGNITO_CLIENT_ID_NATIVE=<native client>` (optional but recommended)
- `COGNITO_CLIENT_SECRET=<secret>` (only for confidential clients)
- `COGNITO_REDIRECT_URI=<https://app.example.com/auth/callback>` (optional override; leave blank to accept caller-supplied values)
- `COGNITO_ISSUER=<https://cognito-idp.<region>.amazonaws.com/<userPoolId>>` (optional; derived automatically when omitted)
- `COGNITO_AUDIENCE=<comma separated list>` (optional; derived from available client IDs)
- `SAFEPOCKET_DEV_JWT_SECRET=<32+ char HMAC secret>` (local fallback only)

### Frontend (`apps/web/.env.local`)
- `NEXT_PUBLIC_COGNITO_DOMAIN=<domain>.auth.<region>.amazoncognito.com`
- `NEXT_PUBLIC_COGNITO_CLIENT_ID=<web client id>`
- `NEXT_PUBLIC_COGNITO_REDIRECT_URI` (optional; defaults to `${origin}/auth/callback`)
- `NEXT_PUBLIC_COGNITO_SCOPE=openid email phone`
- `NEXT_PUBLIC_ENABLE_DEV_LOGIN` *(local only)* – exposes the “dev login” button

### Lambda facade (`infra/lambda`)

For native clients the Lambda function reads secrets from AWS Secrets Manager. Configure:

- `SECRET_COGNITO_NAME` – secret containing Cognito `domain`, `clientId`, `clientSecret`, `redirectUri`, `audience`, etc.
- `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_REDIRECT_URI` – optional environment overrides that take precedence over the secret.

## Web Flow

1. User hits `/login`. If Cognito is enabled and `NEXT_PUBLIC_ENABLE_DEV_LOGIN` is not set, the page immediately redirects to the Hosted UI authorize endpoint.
2. After consent, Cognito redirects to `/auth/callback?code=...&state=...`.
3. Next.js calls the upstream `auth/callback` endpoint (ledger service or Lambda) to exchange the code for tokens.
4. Response tokens are stored as httpOnly cookies:
   - `sp_token` – ID token if present, otherwise access token.
   - `sp_at` – access token for API calls via the middleware.
   - `sp_rt` – refresh token (if Cognito issues one).
5. Authenticated requests include the `Authorization: Bearer` header (via `CookieBearerTokenFilter`). The backend validates JWT signatures using the configured issuer JWKS.

State validation currently encodes the intended redirect path. Hardening with nonces/HMAC is tracked in TODOs.

## Native Client Flow

Native apps launch the Hosted UI in an external browser with a custom scheme (e.g., `safepocket://auth/callback`). After receiving the authorization code:

```
POST https://api.safepocket.app/auth/token
Content-Type: application/json

{
  "grantType": "authorization_code",
  "code": "<authorization_code>",
  "redirectUri": "safepocket://auth/callback",
  "codeVerifier": "<pkce verifier>"   // optional, but recommended
}
```

To refresh tokens:

```
POST https://api.safepocket.app/auth/token
{
  "grantType": "refresh_token",
  "refreshToken": "<refresh token>"
}
```

Responses follow `AuthTokenResponse` in `contracts/openapi.yaml` and include `traceId` for auditing. Mobile clients should store refresh tokens in the system keychain and set the access token in the `Authorization` header for subsequent API calls.

## Dev Fallback

When `SAFEPOCKET_USE_COGNITO=false`, the backend enables an HMAC-signed JWT decoder using `SAFEPOCKET_DEV_JWT_SECRET`. The web login page exposes a “Dev login” button when both:

- `SAFEPOCKET_USE_COGNITO=false`, and
- `NEXT_PUBLIC_ENABLE_DEV_LOGIN=true` (or `SAFEPOCKET_ENABLE_DEV_LOGIN=true` server flag).

Never enable the dev login in production.

## Logout

To perform a full sign-out, clear cookies and redirect to the Cognito logout endpoint:

```
https://<domain>.auth.<region>.amazoncognito.com/logout
  ?client_id=<client id>
  &logout_uri=<https://app.example.com/login>
```

Implementation for `/logout` is tracked; currently the settings page links directly to `/logout` which clears cookies client-side and relies on Hosted UI sign-out when configured.

## Security Notes & TODO

- Enforce HTTPS so cookie `secure` flags remain effective.
- PKCE is partially supported (the BFF forwards `code_verifier` when present). Native clients should supply it; browser clients will adopt PKCE in a future iteration.
- Improve `state` handling with cryptographically secure random nonces bound to the session.
- Consider storing refresh tokens server-side if `offline_access` is added later.
- Rotate Cognito app secrets periodically and update Secrets Manager.

## Validation Checklist

- Missing Cognito env vars → dev login only.
- Valid configuration → `/login` redirects, Hosted UI completes, dashboard renders.
- Tampered/expired tokens → 401 responses; check logs for `invalid_token` warnings with trace IDs.
- Redirect URI mismatch → Cognito error; ensure `${origin}/auth/callback` (or explicit override) is in the app client allowlist.
- Native token exchange → expect HTTP 200 with `accessToken` and `traceId`; errors include structured payloads for debugging.
