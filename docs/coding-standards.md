# Coding Standards

## TypeScript (Next.js)
- TS strict; no `any`. Use `zod` for all inputs/outputs.
- Route Handlers only under `app/api/**`; Server Actions for mutations.
- Use `openapi-typescript`-generated types for BE calls.
- Error handling: never swallow; return JSON with error code + trace_id.
- Rate limiting: `rate-limiter-flexible` with Redis backend (IP+user).
- UI: Tailwind + shadcn/ui; accessible components; no inline cryptography.

## Java (Spring Boot)
- Constructor injection; no field injection.
- DTO immutability; validation annotations (`@Valid`, `@NotNull`, etc.).
- Transactions: service-layer boundaries; avoid n+1 (fetch joins or projections).
- SQL: Prefer JPA for CRUD; heavy analytics via native SQL with indexes.
- RLS: Interceptor to set `appsec.user_id`; enforce policies.
- Logging: JSON via logstash-encoder; include `trace_id`.

## SQL & Migrations
- Flyway versioned: `V1__core.sql`, `V2__rls.sql`, `V3__derived.sql`.
- naming: snake_case; table singular; timestamps = `timestamptz`.
- Money: `numeric(12,2)`. Indexes documented in migration comments.

## Infra & CI
- Docker: multi-stage; distroless runners if feasible.
- CI: lint → test → build → trivy → ECR → ECS rolling.
- No secrets in repo; use Secrets Manager and runtime env only.
