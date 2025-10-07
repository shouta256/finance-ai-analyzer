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

