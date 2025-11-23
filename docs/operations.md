# Operations Guide

This guide captures day-2 operational tasks for Safepocket: database interventions, Plaid rollout, AI configuration, and housekeeping toggles.

## Database Operations

Primary database provider: **Neon (serverless Postgres)**. The migration drops existing RDS data; expect a clean slate after provisioning.

### Missing Database (`DB_NOT_FOUND`)
Indicates the PostgreSQL instance is reachable but the configured database name is absent.

1. In Neon, create a new project/branch (fresh start) and grab the admin connection string (`sslmode=require`).
2. Create the database and user:
   ```bash
   psql "<neon_admin_url>" -v ON_ERROR_STOP=1 <<'SQL'
     -c "CREATE DATABASE safepocket;" \
     -c "CREATE USER safepocket WITH PASSWORD '<app_password>';" \
     -c "GRANT ALL PRIVILEGES ON DATABASE safepocket TO safepocket;"
   SQL
   ```
3. Point services at the Neon endpoint (TLS required):
   ```
   SPRING_DATASOURCE_URL=jdbc:postgresql://<neon-endpoint>:5432/safepocket?sslmode=require
   SAFEPOCKET_DATABASE_URL=postgresql://safepocket:<app_password>@<neon-endpoint>:5432/safepocket?sslmode=require
   ```
4. Restart the ECS service/Lambda (or local process) so Hikari and pg pools re-initialise.

Notes:
- Allowlist egress IPs in the Neon console if outbound traffic is restricted.
- Flyway/bootstrappers will recreate the empty schema; set `SAFEPOCKET_DB_BOOTSTRAP=true` locally to seed demo data.
- Store credentials in Secrets Manager / Parameter Store rather than environment variables.

### Temporary Unavailability (`DB_UNAVAILABLE`)
Raised when the database exists but cannot be reached (network partition, failover, or resource exhaustion).

Checklist:
- Inspect Neon dashboard metrics/events (connection cap, compute resume state, storage).
- If IP allowlisting is enabled in Neon, confirm the current egress IP is permitted.
- Confirm `max_connections` not exceeded; tune Hikari/pg pool sizes if needed (Neon caps are lower than RDS defaults).
- Review application logs for leak warnings or slow queries.

### Local Development Tips

- `docker compose -f infra/compose/docker-compose.yml down -v && make setup` recreates the local Postgres/Redis stack and applies demo data.
- Enable the built-in bootstrapper by setting `SAFEPOCKET_DB_BOOTSTRAP=true` (or exporting it in `.env`). The bootstrapper applies `db/bootstrap/seed.sql` only when core tables are missing.

### Flyway Maintenance (local)

```bash
./apps/ledger-svc/gradlew -p apps/ledger-svc flywayRepair   # fix checksum drift
./apps/ledger-svc/gradlew -p apps/ledger-svc flywayClean flywayMigrate  # destructive reset
```

Flyway defaults:
```
FLYWAY_URL=jdbc:postgresql://localhost:5432/safepocket
FLYWAY_USER=safepocket
FLYWAY_PASSWORD=safepocket
```

Override with `-Dflyway.url=...` when targeting a different instance (e.g., `jdbc:postgresql://<neon-endpoint>:5432/safepocket?sslmode=require`).

## Plaid Configuration

### Secrets to Provision
Store these keys in AWS Secrets Manager or Parameter Store and inject them into ECS/Lambda:

- `PLAID_CLIENT_ID` – organization identifier (shared across environments).
- `PLAID_CLIENT_SECRET` – environment-specific secret (use distinct values for sandbox vs production).
- `PLAID_ENV` – `sandbox`, `development`, or `production`.
- `PLAID_BASE_URL` – matches the environment (`https://sandbox.plaid.com` by default).
- `PLAID_REDIRECT_URI` – required when Plaid-managed OAuth institutions are enabled.
- `PLAID_WEBHOOK_URL` / `PLAID_WEBHOOK_SECRET` – enable webhook delivery and signature verification.
- `SAFEPOCKET_KMS_DATA_KEY` – base64-encoded 256-bit key used to encrypt Plaid access tokens.

Do **not** commit these values to `.env`; use IaC or the AWS console to manage them.

### Production Cutover Checklist
1. Request Plaid production access and confirm approval.
2. Rotate `PLAID_CLIENT_SECRET` to the production value (never reuse sandbox secrets).
3. Update Link configuration in the Plaid dashboard (redirect URI + webhook).
4. Set:
   ```
   PLAID_ENV=production
   PLAID_BASE_URL=https://production.plaid.com
   ```
5. Deploy updated task definitions / Lambda environment.
6. Validate `POST /plaid/link-token` and `POST /transactions/sync` end-to-end (sandbox institutions first, then production).
7. Verify webhook signature validation succeeds (`PLAID_WEBHOOK_SECRET` set, `/webhook/plaid` logs `verified=true`).

## Authentication Modes

- **Cognito (preferred)** – set `SAFEPOCKET_USE_COGNITO=true` along with `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID_WEB`, `COGNITO_CLIENT_ID_NATIVE`, and (if applicable) `COGNITO_CLIENT_SECRET` + `COGNITO_REDIRECT_URI`. The backend derives the audience list automatically.
- **Dev fallback** – omit Cognito variables and configure `SAFEPOCKET_DEV_JWT_SECRET` (>=32 chars). The backend enables an HMAC decoder for local testing; do **not** use this in production.
- Frontend mirrors the backend configuration via `NEXT_PUBLIC_COGNITO_*`. Keep `NEXT_PUBLIC_ENABLE_DEV_LOGIN` disabled outside local environments.

## AI & Chat Configuration

| Variable | Notes |
|----------|-------|
| `SAFEPOCKET_AI_PROVIDER` | `openai` (default) or `gemini`. Determines which credential is required. |
| `SAFEPOCKET_AI_MODEL` | Primary model alias (defaults to `gpt-4o-mini`). |
| `SAFEPOCKET_AI_MODEL_SNAPSHOT` | Optional snapshot ID when the provider requires a dated variant. |
| `SAFEPOCKET_AI_ENDPOINT` | Override the Responses endpoint (only needed for private gateways). |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | Supply at least one key to enable live summaries/chat. |
| `SAFEPOCKET_AI_TIMEOUT_MS` | Increases HTTP read timeout (default 90s). |
| `SAFEPOCKET_CHAT_RETENTION_DAYS` | Chat history retention window (default 30). |
| `SAFEPOCKET_CHAT_CLEANUP_CRON` | Cron expression for scheduled cleanup (`0 30 3 * * *` by default). |

- When **no** API key is present the ledger service returns deterministic fallback summaries and assistant replies (no network calls). Expect a single WARN log the first time the fallback activates.
- Monthly highlights are cached per user in `ai_monthly_highlights`. To reset highlights, delete the row or call `/transactions/reset` with `unlinkPlaid=true`.

## Demo & Maintenance Workflows

- `SAFEPOCKET_DEMO_SEED=true` populates demo transactions the first time `/transactions/sync` runs. Keep it `false` in production.
- The dashboard settings page (`/settings`) drives operational calls:
  - **Sync now** – `POST /api/transactions/sync`
  - **Reset data** – `POST /api/transactions/reset` (optionally `{ "unlinkPlaid": true }`)
  - **Clear chat** – `DELETE /api/chat` (alias for `/ai/chat`)
  - **Unlink/Re-link** – `POST /api/transactions/reset` with `unlinkPlaid` followed by the Plaid Link flow
- Lambda exposes maintenance endpoints (see `infra/lambda/index.js`) such as `/maint/bootstrap` and `/auth/token` for native clients. Keep these protected via IAM/headers (`ADMIN_SQL_TOKEN`) where applicable.

## Monitoring & Alerting

- Ledger service logs include `traceId` for correlation. The BFF propagates `X-Trace-Id`.
- Health checks: `/healthz` (application) and `/actuator/health/liveness` (container).
- Add CloudWatch alarms on:
  - Plaid failures (`Plaid public token exchange failed`)
  - AI fallbacks (unexpected volume)
  - Database connectivity (`DB_NOT_FOUND`, `DB_UNAVAILABLE`)
- Consider enabling structured log shipping (e.g., to CloudWatch Logs or OpenSearch) for production observability.
