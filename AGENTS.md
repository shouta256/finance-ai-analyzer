# AGENTS.md — Safepocket

> This file is the **single source of truth for coding agents** (OpenAI Codex/GPT Agents/IDE bots).
> **Follow commands exactly**. If context is needed, read the referenced files only.

## 0) Objectives (Do this first)
- Implement and maintain **Phase 1 MVP** of Safepocket (FinTech × AI × Security).
- Deliver: account linking (Plaid Sandbox), transaction sync, dashboard (summary/by-category/top-merchants), anomaly detection (z-score/IQR), AI highlight.

## 1) Monorepo map (read only these when needed)
- **contracts/openapi.yaml** — API contract. Keep server/client in sync.
- **apps/web/** — Next.js (App Router) = BFF+Web. Route Handlers + Server Actions.
- **apps/ledger-svc/** — Spring Boot core (transactions, analytics, Plaid).
- **infra/terraform/** — AWS (ECS, ALB/WAF, RDS, ElastiCache, Cognito, ECR).
- **infra/compose/** — Local Docker for Postgres/Redis/Web/BE.
- **docs/** — human-facing specs (requirements, architecture, coding standards, ops).

## 2) Setup commands (local dev)
- Prereq: Docker, Java 21, Node 18+, pnpm, PostgreSQL client.
- Start stack:
  - `docker compose -f infra/compose/docker-compose.yml up -d`
  - `pnpm -C apps/web install && pnpm -C apps/web dev`
  - `./apps/ledger-svc/gradlew -p apps/ledger-svc bootRun`
- Migrations are applied via **Flyway** on BE startup.

## 3) Build & test
- Web unit: `pnpm -C apps/web test`
- Web e2e: `pnpm -C apps/web e2e` (Playwright; requires server)
- BE unit/integration: `./apps/ledger-svc/gradlew test`
- Lint/format: `pnpm -C apps/web biome:fix` / `./apps/ledger-svc/gradlew spotlessApply`

## 4) Run key workflows
- **Plaid Sandbox Link**:
  1. Web calls `POST /plaid/link-token` (BE)
  2. Frontend opens Plaid Link with token
  3. After success, Web posts `public_token` to `POST /plaid/exchange`
  4. Trigger `POST /transactions/sync`
- **Dashboard**: `GET /analytics/summary?month=YYYY-MM`
- **Edit category**: `PATCH /transactions/{id}`

## 5) Code style (strict)
- **TypeScript**: strict mode. Zod for input/output. No `any`.
- **Java**: Spring Boot 3, immutable DTOs, constructor injection only.
- **SQL**: snake_case, `numeric(12,2)`, `timestamptz`, avoid SELECT *.
- See `docs/coding-standards.md` for full rules.

## 6) Security rules (must follow)
- Verify Cognito JWT in **web/middleware**; enforce rate-limit with Redis.
- Before any DB query on BE: set `SET LOCAL appsec.user_id = '<uuid>'` (RLS).
- Encrypt Plaid `access_token` using KMS at app-layer before storing.
- Verify Plaid webhook signature; use `Idempotency-Key` on write paths.

## 7) Files an agent may modify
- ✅ `apps/web/**`, `apps/ledger-svc/**`, `contracts/openapi.yaml`, tests, CI/CD.
- ❌ Do **not** commit secrets or touch `infra/terraform/prod/*` without an explicit issue.

## 8) How to change the API (contract-first)
- Edit `contracts/openapi.yaml` → generate types for Web (`openapi-typescript`) → implement BE controller → update tests.

## 9) Common tasks (ready-made prompts)
- **Add endpoint**: “Add `GET /analytics/top-merchants` (month param). Update openapi, BE controller/service/repo, Web route, tests.”
- **Fix slow query**: “Analyze `EXPLAIN ANALYZE` of transaction list; propose index or partial index and migrate via Flyway.”

## 10) CI/CD (summary)
- GitHub Actions: lint → test → build → trivy scan → push to ECR → update ECS service (rolling).
- Use OIDC to assume AWS role. No long-lived keys.

## 11) References
- Requirements: `docs/requirements/phase1-mvp.md`
- Architecture: `docs/architecture.md`
- Coding standards: `docs/coding-standards.md`
- Ops/Runbook: `docs/operations.md`

