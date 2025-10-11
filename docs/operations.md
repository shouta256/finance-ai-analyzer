# Operations Guide

## Database Operations

### Missing Database (DB_NOT_FOUND)
When the backend returns error code `DB_NOT_FOUND`, the PostgreSQL instance is reachable but the configured database name does not exist.

#### Remediation
1. Create database & user (psql):
```
psql "postgresql://<master_user>:<password>@<endpoint>:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE safepocket;" \
  -c "CREATE USER safepocket WITH PASSWORD '<app_password>';" \
  -c "GRANT ALL PRIVILEGES ON DATABASE safepocket TO safepocket;"
```
2. Verify application JDBC URL:
```
SPRING_DATASOURCE_URL=jdbc:postgresql://<endpoint>:5432/safepocket?sslmode=require
```
3. Restart application / ECS service so connection pool re-initializes.

#### Notes
- Ensure the security group / network ACL permits traffic from the application tasks to the DB port (5432).
- For production, rotate the user password and store it in a secret manager (e.g., AWS Secrets Manager or SSM Parameter Store) rather than plain environment variables.
- If you later introduce Flyway or Liquibase migrations, they will run after the database exists; keep DDL out of runtime code.

### Temporary Unavailability (DB_UNAVAILABLE)
Returned when the database exists but cannot be reached (network partition, failover, resource exhaustion).

Checklist:
- Check CloudWatch / RDS metrics (CPU, Connections, FreeableMemory, Deadlocks).
- Validate security groups or recent network policy changes.
- Confirm max_connections not exceeded.
- Inspect application logs for connection leak warnings.

### Local Development
The provided Docker Compose launches a local PostgreSQL container with a pre-created `safepocket` database. If you see `DB_NOT_FOUND` locally, the container may have been reset. Re-create:
```
docker compose -f infra/compose/docker-compose.yml down -v
make setup
```

## Plaid Configuration

### Required Secrets
Store the following values in your secret manager (AWS Secrets Manager / Parameter Store) and inject them as environment variables for the `ledger-svc` task definition:
- `PLAID_CLIENT_ID` — Organization-wide identifier (same for sandbox and production).
- `PLAID_CLIENT_SECRET` — Environment-specific secret (`Sandbox` or `Production` value from the Plaid dashboard).
- `PLAID_ENV` — One of `sandbox`, `development`, or `production`.
- `PLAID_BASE_URL` — Plaid API host for the selected environment:
  - Sandbox: `https://sandbox.plaid.com`
  - Development: `https://development.plaid.com`
  - Production: `https://production.plaid.com`
- `PLAID_REDIRECT_URI` — Optional; set if you registered a redirect URI in Plaid (e.g., `https://app.example.com/plaid/callback`).
- `PLAID_WEBHOOK_URL` — Public HTTPS endpoint for Plaid webhooks (optional but recommended in production).
- `PLAID_WEBHOOK_SECRET` — Shared secret for validating webhook signatures.

### Production Cutover Steps
1. Request Plaid production access and ensure your account is approved.
2. Rotate `PLAID_CLIENT_SECRET` to the Production value. Do **not** reuse the sandbox secret.
3. Update the Plaid Link redirect URI in the Plaid dashboard to the production domain and set `PLAID_REDIRECT_URI` accordingly.
4. Switch environment variables for the backend:
   ```
   PLAID_ENV=production
   PLAID_BASE_URL=https://production.plaid.com
   ```
5. Restart the `ledger-svc` service so the new credentials take effect.
6. Verify Link token creation (`POST /plaid/link-token`) succeeds and Plaid transactions sync end-to-end.
7. Enable webhook signature verification by setting `PLAID_WEBHOOK_SECRET` and confirming the Plaid webhook is pointed to `/webhook/plaid`.

> Never commit Plaid secrets to Git. Always rely on the secret manager / runtime environment variables.
