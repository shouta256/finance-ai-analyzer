# Architecture

Safepocket follows a thin-frontend/BFF topology, but it supports two runtime profiles:

- **Java-backed profile**: Next.js forwards domain APIs to Spring Boot `ledger-svc`.
- **Serverless profile**: Vercel/Next.js forwards to API Gateway + Lambda, and Lambda serves the core domain routes directly.

PostgreSQL runs on Neon (managed over TLS). Native/partner integrations use the same contract via the BFF or the Lambda facade. The Spring Boot service remains the richer backend implementation for local development and the full RAG stack.

## Logical View

- Client (web, native)
  → Vercel / CloudFront / API Gateway
  → Next.js App Router (BFF + UI) and Lambda facade
  → Spring Boot `ledger-svc` or standalone Lambda handlers
  → Postgres (Neon) with pgvector + Redis (optional) + Secrets Manager / KMS
  ↔ Plaid Sandbox (webhooks terminate at `/webhook/plaid`)
  ↔ OpenAI Responses API / Google Gemini for AI highlights and chat

The BFF handles Cognito flows, cookie/session management, and request shaping before forwarding calls upstream. In Java-backed deployments, Lambda proxies domain routes to `ledger-svc`. In serverless deployments, Lambda serves the same product surface directly for accounts, transactions, analytics, Plaid flows, and chat.

## Runtime Ownership

- `apps/ledger-svc`
  - Source of truth for the Java-backed profile.
  - Owns the richer transaction, analytics, Plaid, chat, and full RAG implementation.
- `infra/lambda/index.js`
  - Current deployed Lambda entrypoint.
  - Thin compatibility shim that delegates to `infra/lambda/src/router.js`.
- `infra/lambda/src/router.js`
  - Single Lambda runtime implementation.
  - Owns route dispatch for the serverless profile.
- `infra/lambda/src/handlers/*`
  - HTTP-layer handlers grouped by route area.
- `infra/lambda/src/services/*`
  - Shared business logic, integration logic, and data access helpers.

This split exists because the project moved from a richer Java/ECS-oriented backend shape to a lower-cost serverless production shape. The cost decision was intentional, but it temporarily created duplication inside Lambda. That duplication is now resolved by keeping `index.js` as the deployed shim and treating `src/router.js` as the single runtime implementation.

## API Boundary

- Source of truth: `contracts/openapi.yaml` (types generated via `pnpm -C apps/web generate:api`).
- Public paths served by Next.js `/api/*` proxy to upstream roots without the `/api` prefix.
- `apps/ledger-svc` remains the richer backend implementation for accounts, transactions, Plaid, analytics, chat, and RAG.
- `infra/lambda` supports two modes:
  - **Proxy mode** when `LEDGER_SERVICE_URL` or `LEDGER_SERVICE_INTERNAL_URL` is configured.
  - **Standalone mode** when those proxy variables are absent. In this mode Lambda owns accounts, transactions, analytics, Plaid, and chat directly.
- Inside Lambda:
  - `infra/lambda/index.js` preserves the deployed `index.handler` entrypoint.
  - `infra/lambda/src/*` contains the single implementation used by that entrypoint.
- RAG endpoints (`/rag/*`) remain Java-backed only. Standalone Lambda mode returns an explicit `501 RAG_STANDALONE_UNAVAILABLE`.
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
2. Next.js exchanges the code with the auth endpoint, sets httpOnly cookies (`sp_token`, `sp_at`, `sp_rt`), and redirects to the dashboard.
3. Middleware and backend adapters translate cookies into `Authorization: Bearer` headers for API requests.
4. The active backend validates JWTs using Cognito JWKS. In local/dev fallback mode a signed HMAC token is accepted via `SAFEPOCKET_DEV_JWT_SECRET`.
5. The active backend resolves the UUID principal and enforces per-user data isolation before SQL executes.
6. Sensitive columns (Plaid access tokens) are encrypted using `SAFEPOCKET_KMS_DATA_KEY` (AES-256 envelope key).
7. Incoming Plaid webhooks require signature verification (`Plaid-Verification` JWT) unless running in a non-prod profile.

## Deployment Topology

- **Java-backed deployment**: `next-web` (Next.js) and `ledger-svc` (Spring Boot) can run behind the same ALB or equivalent private networking. Lambda acts as a public/native/auth facade and compatibility proxy.
- **Serverless deployment**: `next-web` runs on Vercel (or equivalent) and points domain APIs at API Gateway/Lambda. Lambda handles accounts, transactions, analytics, Plaid, and chat directly to remove ECS fixed cost.
- **Neon (PostgreSQL)**: primary data store (serverless Postgres) with pgvector enabled for semantic search.
- **ElastiCache (Redis)**: caching and lightweight coordination (pending rate-limiter support).
- **Secrets Manager / Parameter Store**: Plaid and Cognito bundles referenced by ECS/Lambda; `SAFEPOCKET_KMS_DATA_KEY` seeded here.
- **CI/CD**: GitHub Actions runs lint/test/build for web + backend, packages Lambda, publishes Docker layers, and deploys via OIDC.

## Plaid Flow (Stage 1 Sandbox)

1. `POST /plaid/link-token` generates a token scoped to the authenticated user (optionally includes redirect URI and webhook URL).
2. Client opens Plaid Link; upon success the BFF calls `POST /plaid/exchange` with the `public_token`.
3. The active backend profile encrypts and stores the Plaid access token in `plaid_items`.
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
