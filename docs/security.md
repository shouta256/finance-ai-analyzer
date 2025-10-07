## Security Configuration Notes

### KMS Data Key
`SAFEPOCKET_KMS_DATA_KEY` is not currently provided in production deployments. The service falls back to generating a volatile in-memory key each boot (see startup log: `SAFEPOCKET_KMS_DATA_KEY not provided; generated volatile key`). This is acceptable for local/dev only because any encrypted payload cannot be decrypted after a restart.

Provide a stable, base64-encoded 256-bit key (or integrate with AWS KMS for envelope encryption) before storing persistent sensitive data.

### Recommendations
- Add `SAFEPOCKET_KMS_DATA_KEY` as a GitHub Actions Secret and inject into ECS similar to other secrets.
- Rotate the key via KMS and store only the ciphertext (if integrating KMS).
- Add a startup check to fail fast if `SAFEPOCKET_USE_COGNITO=true` (production mode) and the data key is missing.
