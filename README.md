# Safepocket

## Health checks

### Backend (ledger-svc)
- Primary (ALB target group): `GET /actuator/health`  
  - Spring Boot aggregate health. When the database is down it returns `DOWN` / 503 so the ALB removes the task.
- Liveness (container internal / debug): `GET /actuator/health/liveness`  
  - Returns `UP` even when the database is not ready. Used to confirm the process is alive.
- Readiness: `GET /actuator/health/readiness`  
  - Includes external dependencies.

### Frontend (web)
- Simple health: `GET /api/healthz`  
  - Lightweight JSON: `{ "status": "ok" }`  
  - Used by the ALB target group and external monitoring.

## Runtime Ports
- Frontend: 3000 (0.0.0.0 bind)
- Backend: 8081 (0.0.0.0 bind)

## Docker HEALTHCHECK
`apps/ledger-svc/Dockerfile` also checks `/actuator/health` so it matches the ALB:
```
HEALTHCHECK --start-period=45s --interval=30s --timeout=5s --retries=5 CMD curl -fsS http://localhost:8081/actuator/health || exit 1
```

## Environment variables (database)
You can override the backend `application.yml` with these variables:
- `SPRING_DATASOURCE_URL` (default: `jdbc:postgresql://localhost:5432/safepocket`)
- `SPRING_DATASOURCE_USERNAME` (default: `safepocket`)
- `SPRING_DATASOURCE_PASSWORD` (default: `safepocket`)

On ECS we inject them from Secrets Manager or SSM as task environment variables.

## Local start (quick list)
1. Start infra (PostgreSQL / Redis): `docker compose -f infra/compose/docker-compose.yml up -d`
2. Backend: `./apps/ledger-svc/gradlew -p apps/ledger-svc bootRun`
3. Frontend: `pnpm -C apps/web dev`

## RAG demo (simple family budget sample)
- Run `pnpm demo` or `make demo` to replay the flow locally:
  1. Read `examples/rag-demo-input.csv`
  2. Build simple vectors and create category / merchant summaries (`examples/rag-demo-summary.json`)
  3. Produce sample Q&A search output (`examples/rag-demo-qa.json`)
- Logs print to the console and the files are stored under `examples/`.
- The demo is local only and does not touch production services or external APIs.

## Health feature summary
- Enable Actuator probes (`management.endpoint.health.probes.enabled=true`).
- Add liveness/readiness. Liveness does not depend on the database.
- Control datasource with environment variables so the service does not stop on first failure.
- Add `HEALTHCHECK` to the backend Dockerfile.
- Add `/api/healthz` on the frontend.
- Bind `next start` to `0.0.0.0:3000` explicitly.
