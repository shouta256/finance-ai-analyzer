# Security Configuration Notes

Safepocket is built around a zero-trust posture: Cognito-issued JWTs, Row Level Security in Postgres, encrypted Plaid credentials, and audited AI usage. This document summarises the critical runtime controls.

## Authentication & Session Handling

- Cognito Hosted UI (Authorization Code + PKCE) is the canonical login path. Configure via `SAFEPOCKET_USE_COGNITO=true` and related `COGNITO_*` variables (see `docs/auth-cognito.md`).
- The web BFF stores tokens as httpOnly cookies (`sp_token`, `sp_at`, `sp_rt`). `CookieBearerTokenFilter` injects the bearer token into API calls; JavaScript never touches tokens directly.
- When Cognito is disabled (local dev) the backend enables an HMAC decoder. Set `SAFEPOCKET_DEV_JWT_SECRET` (>=32 chars). Never enable dev login in production.
- JWT validation uses the Cognito JWKS endpoint. Audience lists are derived from configured client IDs; mismatches are logged with the request `traceId`.

## Authorization & Data Isolation

- Every request sets `SET LOCAL appsec.user_id = '<uuid>'` via `RlsGuard`. Postgres RLS policies rely on this GUC for tenant isolation.
- Always resolve the authenticated user ID through `AuthenticatedUserProvider.requireCurrentUserId()`; never trust client-supplied IDs.
- Scheduled maintenance or background jobs must also set `appsec.user_id` before querying.

## Plaid Secrets & Encryption

- `SAFEPOCKET_KMS_DATA_KEY` is **required** in production. It must be a base64-encoded 256-bit key used by `KmsEnvelopeEncryptor` to protect Plaid access tokens at rest.
- In dev, a volatile key is generated when the env var is missing (logged once). Encrypted records created with the volatile key cannot be decrypted after a restart—acceptable for local work only.
- Rotate the key through AWS KMS, store only ciphertext in Secrets Manager, and inject the plaintext via ECS task definitions or Lambda environment variables.

## Plaid Webhook Verification

- Endpoint: `POST /webhook/plaid`.
- Verification steps:
  1. Read `Plaid-Verification` (JWT).
  2. Fetch JWK via `/webhook_verification_key/get` using Plaid credentials.
  3. Validate ES256 signature, `issuer`, and `iat` (±5 minutes).
  4. Compare `request_body_sha256` with the actual request payload hash.
- Production: missing/invalid signatures → `401`.
- Non-prod: absence of the header logs a WARN and bypasses verification to simplify local testing.

## Secrets Management

- Store all runtime secrets in AWS Secrets Manager / Parameter Store:
  - `SECRET_COGNITO_NAME` bundle (domain, client IDs, secret, redirect URIs, JWKS URL).
  - `SECRET_PLAID_NAME` bundle (client id/secret, webhook keys).
  - `SAFEPOCKET_KMS_DATA_KEY`.
  - Any auxiliary toggles (`ADMIN_SQL_TOKEN`, AI keys, etc.).
- GitHub Actions requires `AWS_DEPLOY_ROLE_ARN`, `LAMBDA_FUNCTION_NAME`, and optional overrides (documented in `GITHUB_SECRETS_SETUP.md`).
- Never commit `.env` with real values.

## AI Usage Controls

- AI summaries/chat require `OPENAI_API_KEY` or `GEMINI_API_KEY`. When keys are absent the system falls back to deterministic text and emits a single WARN (no external traffic).
- `SAFEPOCKET_AI_TIMEOUT_MS` limits long-running calls. Increase cautiously; long timeouts block request threads.
- `SAFEPOCKET_CHAT_RETENTION_DAYS` governs how long conversations persist. Scheduled cleanup runs according to `SAFEPOCKET_CHAT_CLEANUP_CRON`.
- Monitor logs for repeated fallbacks or provider errors; these often signal quota issues or credential expiry.

## Operational Hardening Checklist

- Enforce HTTPS end-to-end (ALB listeners + Cognito Hosted UI redirects).
- Configure WAF rules for the ALB / CloudFront distribution.
- Enable AWS CloudTrail + CloudWatch alarms targeting auth failures and Plaid webhook anomalies.
- Ensure ECS task IAM roles have least privilege: access to Secrets Manager, KMS decrypt, and necessary AWS APIs only.
- Regularly run dependency scanning (enabled via GitHub Actions) and Trivy scans on container images.
