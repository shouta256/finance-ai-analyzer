# Cognito Authentication Flow

This document describes how Safepocket integrates with Amazon Cognito (Authorization Code Flow). Current production configuration uses the **Option A (original) user pool**.

> NOTE: PKCE + improved state validation are listed in the TODO section and not yet enabled.

## Environment Variables

Backend (`apps/ledger-svc`):
- `SAFEPOCKET_USE_COGNITO=true`
- `SAFEPOCKET_DEV_JWT_SECRET` (omit in production)
- `COGNITO_REGION=us-east-1`
- `COGNITO_USER_POOL_ID=<prod pool id>` (Option A pool)
- `COGNITO_CLIENT_ID_WEB=<web app client id>`
- `COGNITO_CLIENT_ID_NATIVE=<native app client id>`
- (optional) `COGNITO_CLIENT_ID` (fallback if both above absent)
- (optional) `COGNITO_CLIENT_SECRET=<secret>` (only if app client has secret; then token exchange uses Basic Auth)
- (optional) `COGNITO_ISSUER` override. Default: `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`
- (optional) `COGNITO_AUDIENCE` override. Default: derived from client ids (comma-separated)

Frontend (`apps/web`):
- `NEXT_PUBLIC_COGNITO_DOMAIN=<domain>.auth.us-east-1.amazoncognito.com`
- `NEXT_PUBLIC_COGNITO_CLIENT_ID=<prod app client id>`
- `NEXT_PUBLIC_COGNITO_SCOPE=openid email phone` (remove `profile` unless explicitly allowed in Cognito console)
- (optional) `NEXT_PUBLIC_COGNITO_REDIRECT_URI=https://app.shota256.me/auth/callback` (used only if host matches at runtime; otherwise code computes `${origin}/auth/callback`)
- (optional) `NEXT_PUBLIC_ENABLE_DEV_LOGIN=true` (never set in prod unless intentionally exposing dev login)
- (optional) `SAFEPOCKET_ENABLE_DEV_LOGIN=true` (server-only flag that mirrors the frontend one when running a production build locally)
- (optional) `NEXT_PUBLIC_AUTH_DEBUG=true` (exposes a debug panel on `/login`)

## Flow Summary
1. User visits `/login`.
2. If Cognito is enabled and dev login not explicitly allowed in production: auto-redirect to Hosted UI.
3. Hosted UI authorize URL constructed with dynamic `redirect_uri` (ensures production host vs localhost mismatch is avoided):
   `https://{domain}/oauth2/authorize?client_id=...&response_type=code&scope=...&redirect_uri=...&state=...`
4. Cognito redirects to `/auth/callback?code=...&state=...`.
5. Callback exchanges code → tokens via `POST https://{domain}/oauth2/token` (uses Basic auth when secret present else form params).
6. ID token (or access token fallback) stored as `sp_token` (httpOnly, secure in HTTPS).
7. Middleware enforces authentication; backend validates JWT again on API calls.

## Middleware Auto Configuration
If `COGNITO_ISSUER` is absent it is derived from region + pool id. JWKS endpoint is standard: `${issuer}/.well-known/jwks.json`.
Audience defaults to `COGNITO_CLIENT_ID` unless overridden.

## Dev Fallback
Absent Cognito vars: only the dev login button is shown. Production best practice: omit `NEXT_PUBLIC_ENABLE_DEV_LOGIN` (and the server-only `SAFEPOCKET_ENABLE_DEV_LOGIN`) and ensure backend dev endpoint guarded or disabled.

## Logout (Planned)
Implement `/logout` to clear cookie and redirect to:
`https://{domain}/logout?client_id=...&logout_uri=<encoded post-logout URL>`.

## Security Notes
- HTTPS required so `secure` cookie flag works.
- Current `state` uses redirect path only. Upgrade: cryptographically random + server-side nonce binding.
- Add PKCE (code_challenge + verifier) for public clients (web SPA) to reduce interception risk.
- Limit scopes to required: `openid email phone`.
- Consider rotating app client secret if ever exposed in logs.

## Testing Checklist
- Missing env vars -> dev login only.
- Env vars set (prod) -> auto redirect occurs, or button visible if dev login allowed.
- Successful auth -> cookie set + redirected to dashboard.
- Tampered/expired token -> 401 then redirect /login.
- Wrong redirect URI (mismatch) -> Cognito `redirect_mismatch` error (resolved by dynamic redirect logic).

## Rollout Steps (Production)
1. In Cognito console ensure callback + sign-out URLs include `https://app.shota256.me/auth/callback`.
2. Set backend environment: `SAFEPOCKET_USE_COGNITO=true`, region/pool/client ids, (secret if needed).
3. Set frontend build env: `NEXT_PUBLIC_COGNITO_DOMAIN`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`, (optional debug flag off), DO NOT set `NEXT_PUBLIC_ENABLE_DEV_LOGIN`.
4. (Optional) Remove legacy/unused new pool to avoid confusion.
5. Deploy; verify `/login` loads then immediately hits Hosted UI; complete login.
6. Capture token in cookie; check protected API returns 200.

## Native App (iOS/Android) Settings

For native clients using a custom URL scheme and a public app client (no secret):

- Backend required envs (example values):
   - `SAFEPOCKET_USE_COGNITO=true`
   - `COGNITO_DOMAIN=https://us-east-1mfd4o5tgy.auth.us-east-1.amazoncognito.com`
   - `COGNITO_CLIENT_ID_NATIVE=p4tu620p2eriv24tb1897d49s`
   - `COGNITO_REDIRECT_URI=safepocket://auth/callback`
- Notes:
   - The backend builds `audience` from available client ids if `COGNITO_AUDIENCE` isn’t set.
   - Most native app clients don’t use a client secret; leave `COGNITO_CLIENT_SECRET` unset.
   - Ensure the exact `redirect_uri` is whitelisted in the Cognito app client.
   - The backend token exchange will send `redirect_uri` you provide; you can also supply it per-request via the token exchange API.

### CI/CD Secrets (GitHub Actions)

Set the following repository/environment secrets for deployments:

- `COGNITO_DOMAIN`
- `COGNITO_CLIENT_ID_WEB`
- `COGNITO_CLIENT_ID_NATIVE`
- (optional) `COGNITO_AUDIENCE`
- (optional) `COGNITO_CLIENT_SECRET` (if web client uses secret)

## TODO / Future Enhancements
- PKCE implementation (`code_challenge` S256 + verifier storage in session cookie).
- Robust `state` (random nonce + HMAC + expiration).
- Logout route + optional global sign-out.
- Refresh token storage / silent renew (if adding `offline_access` scope in future).
- Observability: structured logs for token exchange success/failure.
- Remove alias callback routes once old references are gone.
