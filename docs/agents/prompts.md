# Agent Prompts & Guidelines

## Golden Rules
1) Follow `AGENTS.md` commands exactly; do not improvise tooling.
2) Respect `contracts/openapi.yaml` as the single source of truth for APIs.
3) Keep diffs minimal; include tests; update docs/CHANGELOG if behavior changes.
4) Never write secrets; use placeholders and reference Secrets Manager.

## Prompt: Add endpoint
> Add `GET /analytics/top-merchants?month=YYYY-MM`
> - Update `contracts/openapi.yaml` (response: array of {merchant, total})
> - Implement BE: controller/service/repo, SQL with indexes
> - Implement Web: BFF route + page section
> - Tests: BE unit + Web e2e (fake data)
> - Update docs/architecture.md (API list)

## Prompt: Fix slow query
> Run EXPLAIN ANALYZE on transactions list (filters: user_id, occurred_at, account_id).
> Propose indexes/partial indexes; implement via Flyway migration with safe rollback.
> Provide before/after query plans in PR description.
