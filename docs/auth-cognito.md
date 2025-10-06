# Cognito Authentication Flow

This document describes how Safepocket integrates with Amazon Cognito (Authorization Code Flow + PKCE optional). The frontend uses the Cognito Hosted UI; the backend validates JWTs (ID tokens / Access tokens) via issuer JWKS.

## Environment Variables

Backend (ledger-svc):
- SAFEPOCKET_USE_COGNITO=true
- SAFEPocket_DEV_JWT_SECRET (unset in production)
- COGNITO_REGION=us-east-1
- COGNITO_USER_POOL_ID=us-east-1_XXXXXXX
- COGNITO_CLIENT_ID=xxxxxxxxclientid
- (optional) COGNITO_CLIENT_SECRET=xxxx (if app client secret enabled)
- (optional) COGNITO_ISSUER (override) defaults to https://cognito-idp.{region}.amazonaws.com/{userPoolId}
- (optional) COGNITO_AUDIENCE (override) defaults to client id

Frontend (apps/web):
- NEXT_PUBLIC_COGNITO_DOMAIN=your-domain.auth.us-east-1.amazoncognito.com
- NEXT_PUBLIC_COGNITO_CLIENT_ID=xxxxxxxxclientid
- NEXT_PUBLIC_COGNITO_REDIRECT_URI=https://app.example.com/auth/callback
- NEXT_PUBLIC_COGNITO_SCOPE=openid profile email (optional)

## Flow Summary
1. User clicks "Cognito でサインイン" on `/login` (shown only when the domain & client id env vars are present).
2. Browser is redirected to Hosted UI authorize endpoint:
   `https://{domain}/oauth2/authorize?...`
3. After authentication + consent, Cognito redirects back to `/auth/callback?code=...&state=...`.
4. The callback route exchanges the `code` for tokens at `https://{domain}/oauth2/token`.
5. ID token (preferred) or access token is stored as `safepocket_token` httpOnly cookie.
6. Middleware validates JWT (issuer, audience) using JWKS. Backend also validates on protected API calls.

## Middleware Auto Configuration
If `COGNITO_ISSUER` and `COGNITO_JWKS_URL` are not supplied, the middleware constructs them from `COGNITO_REGION` + `COGNITO_USER_POOL_ID`.
Audience defaults to `COGNITO_CLIENT_ID` unless `COGNITO_AUDIENCE` is explicitly set.

## Dev Fallback
If Cognito variables are absent, the login page presents only the "デモユーザーでログイン" button which calls `/api/dev/login` (available in development). Avoid enabling dev login in production by unsetting the dev secret and not deploying that endpoint publicly.

## Logout (Future)
Add a `/logout` route that clears the cookie and optionally hits Cognito's logout endpoint:
`https://{domain}/logout?client_id=...&logout_uri=...`.

## Security Notes
- Ensure HTTPS so the `secure` flag on cookies is effective.
- Validate `state` to mitigate CSRF (current implementation reuses redirect path; future improvement: random state + session binding).
- Consider storing only access token and re-fetching user info if ID token claims not required client-side.

## Testing Checklist
- Missing env vars -> dev login only.
- With env vars -> Cognito button appears.
- Successful code exchange sets cookie and redirects to dashboard.
- Tampered token -> middleware 401.
- Expired token -> middleware 401 and redirect to `/login`.
