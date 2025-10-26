# Safepocket Native API Guide

This guide summarises how iOS/Android clients (or partner integrations) should talk to Safepocket. All endpoints, schemas, and status codes are defined in `contracts/openapi.yaml`.

## Base URLs

- **Production:** `https://api.safepocket.app`
- **Development:** `http://localhost:8081` (when running the ledger service locally)

The web BFF exposes `/api/*` routes that proxy to the same paths without the prefix. Native clients should call the ledger service (or Lambda facade) directly.

## Authentication

1. Launch the Cognito Hosted UI (Authorization Code + PKCE). Redirect URI should be your custom scheme (e.g., `safepocket://auth/callback`) registered in Cognito.
2. On success, Cognito redirects back with `code` + `state`.
3. Exchange the code with Safepocket:

```
POST /auth/token
Content-Type: application/json

{
  "grantType": "authorization_code",
  "code": "<authorization_code>",
  "redirectUri": "safepocket://auth/callback",
  "codeVerifier": "<pkce verifier>"   // required when PKCE was used
}
```

4. Store the returned `accessToken` (short-lived) and `refreshToken` (if present) securely. Refresh with:

```
POST /auth/token
{
  "grantType": "refresh_token",
  "refreshToken": "<refresh token>"
}
```

Include `Authorization: Bearer <accessToken>` on all subsequent requests.

## Core Endpoints

| Capability | Method & Path | Notes |
|------------|---------------|-------|
| Accounts | `GET /accounts` | Returns balances per linked Plaid item/account. |
| Transactions | `GET /transactions?month=YYYY-MM` | Supports pagination/query filters (`page`, `pageSize`, `from`, `to`, `accountId`). |
| Update transaction | `PATCH /transactions/{transactionId}` | Body allows updating `category` and `notes`. |
| Trigger sync | `POST /transactions/sync` | Optional body `{ "forceFullSync": true, "demoSeed": true, "startMonth": "YYYY-MM" }`. |
| Reset data | `POST /transactions/reset` | Optional `{ "unlinkPlaid": true }` to drop Plaid credentials. |
| Analytics | `GET /analytics/summary?month=YYYY-MM&generateAi=true` | `generateAi` triggers fresh AI highlight creation. |
| AI chat | `GET /ai/chat?conversationId=<uuid>` / `POST /ai/chat` | `POST` body `{ "conversationId"?, "message", "truncateFromMessageId"? }`. |
| Plaid Link token | `POST /plaid/link-token` | Create a new Link token (cache client-side until expiry). |
| Plaid public token exchange | `POST /plaid/exchange` | Body `{ "publicToken": "<token>" }`. |
| RAG search | `POST /rag/search` | Semantic search with filters (`query`, `category`, `merchant`, etc.). |
| RAG summaries | `GET /rag/summaries?month=YYYY-MM` | Lightweight summaries by month/category/merchant. |
| RAG aggregate | `POST /rag/aggregate` | Custom window aggregations (e.g., rolling spend). |

Responses include `traceId` for observability. Persist it in crash logs or support tickets when debugging.

## Plaid Sandbox Flow

1. `POST /plaid/link-token`
2. Launch Plaid Link (native SDK). Obtain `public_token`.
3. `POST /plaid/exchange` with `{ "publicToken": "<public_token>" }`.
4. `POST /transactions/sync` (optionally `forceFullSync=true` on the first sync).

## Error Handling

All non-2xx responses follow:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Something went wrong",
    "details": { "field": "reason" }
  },
  "traceId": "d4b1..."
}
```

Common `error.code` values: `INVALID_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PLAID_ERROR`, `AI_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL`.

## Platform Recommendations

- Use HTTPS only. Disable TLS certificate pinning during development (self-signed certificates may be in play).
- Store refresh tokens in secure key storage (Keychain/Keystore). Access tokens can remain in memory and be refreshed on 401 responses.
- Retry idempotent operations with exponential backoff, respecting `Retry-After` headers when present.
- When calling write endpoints, include a UUID `Idempotency-Key` header to guard against duplicate submissions (support planned on the backend; harmless today).

For additional samples (Swift/Kotlin), open an issue and we can add snippets under `examples/`.
