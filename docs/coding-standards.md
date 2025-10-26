# Coding Standards

Shared principles for Safepocket across the Next.js BFF and Spring Boot backend.

## TypeScript (Next.js)
- Enable `strict` mode; avoid `any`/`unknown` leakage. All route handlers must validate inputs/outputs with Zod.
- Place server-side logic under `app/api/**` (route handlers) or explicit server actions. Keep UI components pure and data fetching inside hooks/services.
- Use OpenAPI-generated types (`src/lib/api-types.ts`) when calling the ledger service. Wrap fetches with `ledgerFetch`/`client-api` helpers so error codes and trace IDs propagate.
- Return structured errors: `{ error: { code, message, traceId? } }` with appropriate HTTP status. Never swallow backend payloads.
- Centralise environment lookups in `src/lib/env.ts`; do not access `process.env` directly inside components.
- UI: Tailwind CSS + design tokens defined in component modules; ensure components are keyboard accessible and meet contrast guidelines.
- Prefer TanStack Query for client-side caching. Invalidate caches explicitly when mutating data.
- Keep browser crypto out of the UI. Sensitive work (JWT parsing, Plaid token handling) stays server-side.

## Java (Spring Boot)
- Constructor injection only; configuration via records (`@ConfigurationProperties`).
- DTOs are immutable records; use Jakarta validation annotations for request payloads.
- Apply `@Transactional` at service boundaries. Avoid n+1 queries by using fetch joins or projections.
- Every request must receive a `traceId` (see `TraceIdFilter`). Include it in logs and error responses.
- Before any SQL, invoke `RlsGuard#setAppsecUser` (handled automatically by service layer helpers). Never query without a user context.
- Encrypt secrets (Plaid access tokens) through `KmsEnvelopeEncryptor`; fail fast when `SAFEPOCKET_KMS_DATA_KEY` is missing in production.
- Use WebClient for outbound HTTP (Plaid, OpenAI) with bounded timeouts. Log warnings (not stack traces) for expected fallback paths.

## SQL & Migrations
- Migrations live under `db/migration/postgresql`. Use semantic file names (e.g., `V6__add_plaid_items_constraints_and_index.sql`).
- Stick to `snake_case`, singular table names, `numeric(12,2)` for currency, and `timestamptz` for dates.
- Document non-obvious indexes and constraints in migration comments.
- The bootstrapper (`db/bootstrap/seed.sql`) is idempotent and meant for local/dev. Disable it in production by leaving `SAFEPOCKET_DB_BOOTSTRAP` unset.

## Testing
- Frontend: Vitest (`pnpm -C apps/web test`) for units, Playwright (`pnpm -C apps/web e2e`) for end-to-end flows. Write tests around API clients, hooks, and UI states.
- Backend: JUnit tests under `src/test/java`. Use `@SpringBootTest` sparingly; prefer slice tests and mocks for external systems.
- Include regression tests when altering contracts (`contracts/openapi.yaml`) or analytics calculations.

## Infra & CI
- Docker images are multi-stage; keep runtime layers minimal.
- GitHub Actions pipeline: lint → test → build → security scan → package Lambda/Docker → deploy (ECS & Lambda) via AWS OIDC.
- Never commit secrets. Production credentials live in AWS Secrets Manager/Parameter Store and are referenced by name (`SECRET_COGNITO_NAME`, `SECRET_PLAID_NAME`, etc.).
- Use `pnpm -C apps/web generate:api` after changing the OpenAPI contract to keep client types in sync.
