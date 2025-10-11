## Security Configuration Notes

### KMS Data Key
`SAFEPOCKET_KMS_DATA_KEY` is REQUIRED in production deployments. From now on, the backend will fail fast on startup if this environment variable is missing when running under the `prod` Spring profile. For local/dev only, the service still falls back to generating a volatile in-memory key (see startup log: `SAFEPOCKET_KMS_DATA_KEY not provided; generated volatile key (non-prod)`). This is acceptable for local/dev because any encrypted payload cannot be decrypted after a restart.

Provide a stable, base64-encoded 256-bit key (or integrate with AWS KMS for envelope encryption) before storing persistent sensitive data.

### Recommendations
- Add `SAFEPOCKET_KMS_DATA_KEY` as a GitHub Actions Secret and inject into ECS similar to other secrets. The value must be a base64-encoded 256-bit key.
- Rotate the key via KMS and store only the ciphertext (if integrating KMS).

### Plaid Webhook Signature
- The Plaid webhook endpoint is `/webhook/plaid` and now enforces signature verification when `PLAID_WEBHOOK_SECRET` is set. In production, if the secret is missing, webhooks are rejected (401). In non-prod, verification is bypassed with a warning to ease local testing.
- Add a startup check to fail fast if `SAFEPOCKET_USE_COGNITO=true` (production mode) and the data key is missing.
