# Safepocket – AI-Powered Personal Finance Dashboard

Smart money management with Plaid-powered account linking, real-time analytics, and AI-assisted insights.

[![CI](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml/badge.svg)](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml)

## Overview

Safepocket links bank accounts via Plaid Sandbox, syncs transactions into a secure ledger, and surfaces spending insights with anomaly detection and AI highlights. The web experience is delivered through a Next.js BFF, while a Spring Boot service handles Plaid orchestration, analytics, and AI summarisation.

## Feature Highlights

- **Plaid Sandbox integration** – create Link tokens, exchange public tokens, trigger syncs, unlink/relink, and wipe data from the in-app settings screen.
- **Dashboard analytics** – income/expense/net totals, category mix, top merchants, anomaly insights (z-score + IQR), sentiment scoring, and custom range comparisons.
- **AI highlight & assistant** – OpenAI Responses API by default (Gemini supported). When no API key is configured the system falls back to deterministic summaries for consistent UX.
- **RAG & semantic workflows** – pgvector-backed embeddings power `/rag/search`, `/rag/summaries`, and `/rag/aggregate` endpoints for native apps and partners.
- **Transaction tooling** – edit categories and notes, request backfills from specific months, clear chat history, and reset synced data via authenticated APIs.
- **Security first** – Cognito Hosted UI + JWT, Redis-backed session helpers, request tracing, RLS enforcement with `SET LOCAL appsec.user_id`, Plaid token encryption via KMS envelope keys, and webhook signature verification.

## System Architecture

```
┌────────────┐     ┌────────────┐     ┌─────────────────┐
│   Client   │ ──▶ │  CloudFront│ ──▶ │  Next.js (BFF)  │
│  Web/Mobile│     │   / ALB    │     │  / Edge Lambda  │
└────────────┘     └────────────┘     └─────────────────┘
                                         │           │
                                         │           ▼
                                         │   ┌────────────────┐
                                         └──▶│ Spring Boot API│
                                             │  (ledger-svc)  │
                                             └────────────────┘
                                                   │ │ │
                ┌──────────────────────────┬───────┘ │ └─────────────┐
                │                          │         │               │
        ┌──────────────┐          ┌────────────┐ ┌───────────┐ ┌──────────────┐
        │PostgreSQL +  │◀──RLS───▶│   Redis    │ │  Secrets  │ │Plaid Sandbox │
        │pgvector      │          │  (Caches)  │ │Mgr +  KMS │ └──────────────┘
        └──────────────┘          └────────────┘ └───────────┘          ▲
                ▲                          ▲                ▲           │
                │                          │                │           │
                └───────────── OpenAI / Gemini ─────────────┴───────────┘
```

## Technology Stack

### Frontend (apps/web)
- Next.js 14 (App Router) with server-side route handlers as the BFF
- TypeScript in strict mode with Zod validation and generated OpenAPI typings
- TanStack Query for data orchestration and caching
- Tailwind CSS + custom component primitives, Chart.js via `react-chartjs-2`
- Vitest + Testing Library for unit tests, Playwright for e2e

### Backend (apps/ledger-svc)
- Spring Boot 3.2 on Java 21 with constructor-injected components
- Spring Security resource server (Cognito JWKS + dev JWT fallback)
- WebClient-based Plaid client, Flyway migrations, and database bootstrapper
- OpenAI Responses client with Gemini fallback, cached monthly highlights, and streaming anomaly detectors
- pgvector-ready RAG services for semantic search/aggregation

### Data & AI
- PostgreSQL 15 with Row Level Security (`SET LOCAL appsec.user_id`)
- Optional Redis 7 for rate limiting and background coordination
- Vector embeddings stored via pgvector (dimension defaults to 1536)
- Deterministic AI fallback when no external credentials are present

### Infrastructure & DevOps
- ECS Fargate services for Next.js and ledger-svc, plus an AWS Lambda facade used by native clients
- AWS Secrets Manager + Parameter Store with envelope encryption (KMS data key)
- GitHub Actions (lint → test → build → security scan → deploy) with OIDC to AWS
- Docker Compose for local Postgres/Redis, multi-stage Dockerfiles for deployments

## Getting Started

### Prerequisites
- Docker & Docker Compose
- Node.js 18+ with pnpm (`corepack enable`)
- Java 21 (Temurin recommended)
- PostgreSQL client tools (`psql`)

### Clone & bootstrap

```bash
git clone https://github.com/shouta256/finance-ai-analyzer.git safepocket
cd safepocket
make setup        # installs web deps, generates API types, builds backend, seeds local DB
```

### Configure environment

Copy and edit the sample files:

```bash
cp .env.example .env
# Create apps/web/.env.local (see sample below) if it does not already exist
```

Key backend variables (loaded by Spring Boot and Makefile):

| Variable | Required | Description |
|----------|----------|-------------|
| `PLAID_CLIENT_ID`, `PLAID_CLIENT_SECRET` | ✅ | Plaid Sandbox credentials for link token creation and transaction sync |
| `PLAID_ENV`, `PLAID_BASE_URL` | ➖ (defaults) | Environment (`sandbox` by default) and API base URL |
| `PLAID_REDIRECT_URI`, `PLAID_WEBHOOK_URL`, `PLAID_WEBHOOK_SECRET` | ➖ | Configure when enabling OAuth institutions and webhook signature verification |
| `SAFEPOCKET_USE_COGNITO` | ✅ (prod) | Toggle Cognito authentication; leave `false` for local dev |
| `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID_WEB`, `COGNITO_CLIENT_ID_NATIVE`, `COGNITO_CLIENT_SECRET`, `COGNITO_REDIRECT_URI` | ✅ when Cognito enabled | Hosted UI domain and client IDs; secret optional (only when the app client uses one) |
| `SAFEPOCKET_DEV_JWT_SECRET` | ✅ (local) | HMAC key for the development JWT decoder; omit in production |
| `OPENAI_API_KEY` or `GEMINI_API_KEY` | ➖ | Provide at least one to enable live AI highlights/chat; deterministic fallback otherwise |
| `SAFEPOCKET_AI_PROVIDER`, `SAFEPOCKET_AI_MODEL`, `SAFEPOCKET_AI_MODEL_SNAPSHOT`, `SAFEPOCKET_AI_ENDPOINT`, `SAFEPOCKET_AI_TIMEOUT_MS` | ➖ | Tune AI provider/model/snapshot and timeout (defaults cover OpenAI Responses `gpt-4o-mini`) |
| `VECTOR_PROVIDER`, `EMBEDDING_MODEL`, `RAG_MAX_ROWS`, `RAG_EMBED_DIM` | ➖ | pgvector configuration for RAG endpoints |
| `SAFEPOCKET_CHAT_RETENTION_DAYS`, `SAFEPOCKET_CHAT_CLEANUP_CRON` | ➖ | Chat retention policy (defaults: 30 days, cleanup at 03:30 UTC) |
| `SAFEPOCKET_DB_BOOTSTRAP` | ➖ | Set `true` locally to apply the idempotent bootstrap schema/seed if migrations haven't run |
| `SAFEPOCKET_DEMO_SEED` | ➖ | When `true`, initial sync inserts demo transactions |

Frontend/BFF variables (`apps/web/.env.local`):

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_BASE` | ✅ | Base URL for requests from the browser (`http://localhost:8081` in dev) |
| `LEDGER_SERVICE_URL`, `LEDGER_SERVICE_INTERNAL_URL`, `LEDGER_SERVICE_PATH_PREFIX` | ➖ | Override when the Next.js server must call the ledger service via an internal address |
| `NEXT_PUBLIC_COGNITO_DOMAIN`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`, `NEXT_PUBLIC_COGNITO_REDIRECT_URI`, `NEXT_PUBLIC_COGNITO_SCOPE` | ✅ when Cognito enabled | Mirrors backend configuration for the Hosted UI |
| `NEXT_PUBLIC_ENABLE_DEV_LOGIN`, `SAFEPOCKET_ENABLE_DEV_LOGIN` | ➖ | Expose the dev login button (local only) |
| `NEXT_PUBLIC_ENV` | ➖ | Display-only indicator for the UI |

Example local file:

```
SAFEPOCKET_DEV_JWT_SECRET=dev-secret-key-for-local-development-only
LEDGER_SERVICE_URL=http://localhost:8081
NEXT_PUBLIC_API_BASE=http://localhost:8081
NEXT_PUBLIC_COGNITO_DOMAIN= # set when enabling Cognito Hosted UI
NEXT_PUBLIC_COGNITO_CLIENT_ID=
NEXT_PUBLIC_COGNITO_REDIRECT_URI=
NEXT_PUBLIC_COGNITO_SCOPE=openid email phone
NEXT_PUBLIC_ENABLE_DEV_LOGIN=true
NEXT_PUBLIC_ENV=local
```

Never commit populated `.env` files. Production secrets live in AWS Secrets Manager / Parameter Store and are wired via ECS task definitions and Lambda environment variables (see `GITHUB_SECRETS_SETUP.md`).

### Run the stack locally

```bash
# Start Postgres + Redis
docker compose -f infra/compose/docker-compose.yml up -d

# Run the backend
./apps/ledger-svc/gradlew -p apps/ledger-svc bootRun

# Run the web app (in a separate terminal)
pnpm -C apps/web dev
```

Alternatively, use `make up` to launch everything with process supervision. The dashboard will be available at `http://localhost:3000`, and the ledger service listens on `http://localhost:8081`.

## Secrets & Environment Management

- Store production credentials in AWS Secrets Manager/Parameter Store. The Lambda facade expects `SECRET_COGNITO_NAME` and `SECRET_PLAID_NAME` to resolve Cognito and Plaid bundles, and it honours `CONFIG_BUMP` for rolling updates.
- GitHub Actions deployments require `AWS_DEPLOY_ROLE_ARN`, `LAMBDA_FUNCTION_NAME`, and the runtime secrets listed in `GITHUB_SECRETS_SETUP.md`.
- `SAFEPOCKET_KMS_DATA_KEY` must be a base64-encoded 256-bit key in production. Without it the backend refuses to start.

## Key Workflows

- **Plaid Link (Sandbox)** – `POST /plaid/link-token` → Plaid Link → `POST /plaid/exchange` → `POST /transactions/sync`. The settings page provides unlink/relink/reset buttons that exercise the same APIs.
- **Transaction sync & anomalies** – Each sync normalises Plaid transactions, enriches merchants/categories, computes z-score and IQR anomalies, and populates analytics projections for the dashboard.
- **Dashboard summary** – `GET /analytics/summary?month=YYYY-MM` powers totals, charts, top merchants, and anomaly callouts. Setting `generateAi=true` requests a fresh AI highlight.
- **AI Assistant** – `GET/POST /ai/chat` (aliases `/api/chat`, `/chat`) provide a persistent conversation per user. Chat history can be cleared from the settings page (`DELETE /api/chat`).
- **RAG APIs** – Native apps can call `/rag/search`, `/rag/summaries`, and `/rag/aggregate` for semantic insights. Embeddings are generated lazily using the configured provider/model.

## Testing & Tooling

```bash
# Frontend
pnpm -C apps/web test        # Vitest unit tests
pnpm -C apps/web e2e         # Playwright end-to-end tests

# Backend
./apps/ledger-svc/gradlew -p apps/ledger-svc test

# Lint & format
pnpm -C apps/web biome:fix
./apps/ledger-svc/gradlew spotlessApply
```

## Documentation

- `docs/architecture.md` – system design and deployment topology
- `docs/operations.md` – runbooks, Plaid rollout steps, AI configuration
- `docs/auth-cognito.md` – Cognito Hosted UI integration details
- `docs/native-api-usage.md` – guidance for native/mobile clients
- `docs/security.md` – security controls, KMS usage, webhook verification
- `contracts/openapi.yaml` – contract-first API definition (generate typings with `pnpm -C apps/web generate:api`)

## License & Credits

- Developer: Shota Suzuki ([@shouta256](https://github.com/shouta256))
- Project purpose: Phase 1 MVP showcase combining FinTech, AI, and security best practices
- Tooling: GitHub Copilot + custom automation pipelines
