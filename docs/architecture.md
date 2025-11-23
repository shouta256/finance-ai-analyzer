# Architecture

Safepocket follows a thin-frontend/BFF topology. Next.js exposes the only public surface, while the Spring Boot ledger service and supporting infrastructure live in a private VPC. PostgreSQL now runs on Neon (managed over TLS), and native/partner integrations interact with the same contract via the BFF or an AWS Lambda facade.

## Logical View

- Client (web, native)  
  → CloudFront / Application Load Balancer  
  → Next.js App Router (BFF + UI) and edge Lambda  
  → Spring Boot `ledger-svc` (private ECS service)  
  → Postgres (Neon) with pgvector + Redis (ElastiCache) + Secrets Manager / KMS  
  ↔ Plaid Sandbox (webhooks terminate at `/webhook/plaid`)  
  ↔ OpenAI Responses API / Google Gemini for AI highlights and chat

The BFF handles Cognito flows, cookie/session management, and request shaping before forwarding calls to the ledger service. Lambda (deployed from `infra/lambda`) mirrors a subset of routes for mobile clients that require a serverless endpoint.

## API Boundary

- Source of truth: `contracts/openapi.yaml` (types generated via `pnpm -C apps/web generate:api`).
- Public paths served by Next.js `/api/*` proxy to ledger-svc roots without the `/api` prefix.
- Phase 1 endpoints:
  - Authentication: `POST /auth/token`, `GET /auth/callback` (lambda facade), `/login` dev helpers
  - Plaid: `POST /plaid/link-token`, `POST /plaid/exchange`, `POST /transactions/sync`, `POST /transactions/reset`
  - Transactions: `GET /transactions`, `PATCH /transactions/{transactionId}`
  - Accounts: `GET /accounts`
  - Analytics: `GET /analytics/summary` (optional `generateAi=true`)
  - AI assistant: `GET /ai/chat`, `POST /ai/chat`
  - RAG: `POST /rag/search`, `GET /rag/summaries`, `POST /rag/aggregate`
  - User lifecycle: `DELETE /users/{userId}` (admin/maintenance only)

## Data Model

- PostgreSQL 15 with Row Level Security driven by `SET LOCAL appsec.user_id` per request.
- Core tables: `users`, `accounts`, `transactions`, `merchants`, `plaid_items`, `chat_messages`, `ai_monthly_highlights`.
- Optional/feature-flagged tables (created when enabling pgvector migrations): `tx_embeddings`.
- Monetary values use `numeric(12,2)`; timestamps use `timestamptz` (UTC).
- idempotent bootstrap (`safepocket.db.bootstrap-enabled=true`) creates baseline schema and demo rows when Flyway history is empty.

## Security Path

1. Cognito Hosted UI (Authorization Code + optional PKCE) returns to Next.js `/auth/callback`.
2. Next.js exchanges the code with the ledger service / Lambda facade, sets httpOnly cookies (`sp_token`, `sp_at`, `sp_rt`), and redirects to the dashboard.
3. Middleware and `CookieBearerTokenFilter` translate cookies into `Authorization: Bearer` headers for API requests.
4. Spring Security validates JWTs using Cognito JWKS. When Cognito is disabled (local dev) a signed HMAC token is accepted via `SAFEPOCKET_DEV_JWT_SECRET`.
5. `AuthenticatedUserFilter` resolves the UUID principal and `RlsGuard` issues `SET LOCAL appsec.user_id = '<uuid>'` on the connection before any SQL executes.
6. Sensitive columns (Plaid access tokens) are encrypted using `SAFEPOCKET_KMS_DATA_KEY` (AES-256 envelope key). Missing keys cause production startup to fail fast.
7. Incoming Plaid webhooks require signature verification (`Plaid-Verification` JWT) unless running in a non-prod profile.

## Deployment Topology

- **ECS Fargate**: `next-web` (Next.js) and `ledger-svc` (Spring Boot) behind a shared ALB.
- **Lambda**: `hello-http` function acts as an API facade for mobile clients and administrative tasks.
- **Neon (PostgreSQL)**: primary data store (serverless Postgres) with pgvector enabled for semantic search.
- **ElastiCache (Redis)**: caching and lightweight coordination (pending rate-limiter support).
- **Secrets Manager / Parameter Store**: Plaid and Cognito bundles referenced by ECS/Lambda; `SAFEPOCKET_KMS_DATA_KEY` seeded here.
- **CI/CD**: GitHub Actions runs lint/test/build for web + backend, packages Lambda, publishes Docker layers, and deploys via OIDC.

## Plaid Flow (Stage 1 Sandbox)

1. `POST /plaid/link-token` generates a token scoped to the authenticated user (optionally includes redirect URI and webhook URL).
2. Client opens Plaid Link; upon success the BFF calls `POST /plaid/exchange` with the `public_token`.
3. The ledger service encrypts and stores the Plaid access token in `plaid_items`.
4. `/transactions/sync` pulls transactions, normalises merchants/categories, computes anomalies, and updates analytics aggregates.
5. Dashboard pulls `GET /analytics/summary` and `GET /transactions` for the selected month. New highlights are generated when `generateAi=true`.
6. Settings actions allow unlinking (drops `plaid_items`), re-linking, demo seeding, and full resets through `/transactions/reset`.

### Environment Variables (Plaid)

| Variable | Purpose |
|----------|---------|
| `PLAID_CLIENT_ID`, `PLAID_CLIENT_SECRET` | Required credentials for every environment |
| `PLAID_ENV` | `sandbox`, `development`, or `production` (defaults to `sandbox`) |
| `PLAID_BASE_URL` | API base URL; align with environment |
| `PLAID_REDIRECT_URI` | Set when Plaid redirect-based OAuth institutions are enabled |
| `PLAID_WEBHOOK_URL`, `PLAID_WEBHOOK_SECRET` | Enable webhook delivery + signature verification |
| `SAFEPOCKET_KMS_DATA_KEY` | Base64-encoded 256-bit key used to encrypt Plaid access tokens before persistence |

Keep these values in AWS Secrets Manager/Parameter Store; do not commit them to `.env`.
