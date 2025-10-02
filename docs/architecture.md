# Architecture

## Logical View
Client → **ALB+WAF** → **Next.js (BFF+Web on ECS Fargate)** → **Spring Boot (ledger-svc on ECS Fargate)**
→ **RDS Postgres** (RLS) / **ElastiCache Redis** / **Secrets Manager + KMS** / **S3**
↔ Plaid (Sandbox Webhook → /webhook/plaid)
↔ OpenAI (AI summarization via Responses API)

## API Boundary
- Public surface: Next.js only; Spring is private (VPC).
- Contract-first via `contracts/openapi.yaml` (types generated to web).
- Phase 1 REST endpoints:
  - `POST /plaid/link-token`
  - `POST /plaid/exchange`
  - `POST /transactions/sync`
  - `GET /transactions`
  - `PATCH /transactions/{id}`
  - `GET /analytics/summary`

## Data
- PostgreSQL with RLS; tables for user/account/transaction/merchant/category/anomaly/security_event/webhook/idempotency/exchange_rate.
- Money type: `numeric(12,2)`; UTC `timestamptz`.
- Future: monthly partitioning; materialized views for heavy analytics.

## Security Path
- Cognito Hosted UI → JWT → web middleware verify.
- BE sets `SET LOCAL appsec.user_id` for RLS per request.
- KMS encrypt Plaid access_token before DB write.

## Deployment
- ECS services: `next-web`, `ledger-svc`.
- ALB paths: `/*` → web, `/api/*` → ledger, `/webhook/plaid` → ledger (POST).
- CI: GitHub Actions (OIDC) → ECR push → ECS update → Trivy scan.

## Sequence (Plaid)
1) `POST /plaid/link-token` → open Link in web
2) `POST /plaid/exchange` saves encrypted access_token
3) `POST /transactions/sync` → `/transactions/sync` (Plaid) → store → Redis events
4) `GET /analytics/summary` (LLM optional) → return dashboard data
