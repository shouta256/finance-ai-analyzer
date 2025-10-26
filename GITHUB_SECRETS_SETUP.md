# GitHub Secrets Setup Guide

Safepocket deployments run through GitHub Actions with OIDC access to AWS. This document lists the repository/environment secrets required for automated builds and runtime configuration.

Add secrets at:  
`https://github.com/shouta256/finance-ai-analyzer/settings/secrets/actions`

## AWS / Pipeline

| Name | Purpose |
|------|---------|
| `AWS_DEPLOY_ROLE_ARN` | IAM role (trusted via GitHub OIDC) with permissions to update Lambda layers/functions and ECS task definitions. |
| `LAMBDA_FUNCTION_NAME` | Target AWS Lambda function (defaults to `hello-http` if unset). |

## Cognito

You can store individual variables or a JSON bundle in Secrets Manager (referenced by `SECRET_COGNITO_NAME`). At minimum configure:

| Name | Example | Notes |
|------|---------|-------|
| `COGNITO_DOMAIN` | `https://us-east-1mfd4o5tgy.auth.us-east-1.amazoncognito.com` | Hosted UI domain (no trailing slash). |
| `COGNITO_CLIENT_ID_WEB` | `5ge4c1b382ft2v71rvip0rrhqv` | Web client ID. |
| `COGNITO_CLIENT_ID_NATIVE` | `p4tu620p2eriv24tb1897d49s` | Native client ID (no secret). |
| `COGNITO_CLIENT_SECRET` | `...` | Only for confidential clients (web). |
| `COGNITO_REDIRECT_URI` | `https://app.safepocket.app/auth/callback` | Optional override; Lambda uses this when exchanging tokens. |
| `SECRET_COGNITO_NAME` | `/safepocket/cognito` | Secrets Manager path storing an equivalent JSON payload (domain/client ids/secret/audience). |

## Plaid

| Name | Example | Notes |
|------|---------|-------|
| `PLAID_CLIENT_ID` | `demo-client` | Sandbox client ID. |
| `PLAID_CLIENT_SECRET` | `demo-secret` | Sandbox secret (use distinct secret per environment). |
| `PLAID_ENV` | `sandbox` | Set to `production` when cutting over. |
| `PLAID_BASE_URL` | `https://sandbox.plaid.com` | Align with environment. |
| `PLAID_REDIRECT_URI` | `https://app.safepocket.app/plaid/callback` | Optional; enable for OAuth institutions. |
| `PLAID_WEBHOOK_URL` | `https://api.safepocket.app/webhook/plaid` | Required for production webhooks. |
| `PLAID_WEBHOOK_SECRET` | `whsec_...` | Shared secret for webhook signature verification. |
| `SECRET_PLAID_NAME` | `/safepocket/plaid` | Secrets Manager entry consumed by Lambda. |

## AI & Data Protection

| Name | Notes |
|------|-------|
| `OPENAI_API_KEY` | Enable OpenAI Responses (default provider). |
| `GEMINI_API_KEY` | Optional alternative provider (`SAFEPOCKET_AI_PROVIDER=gemini`). |
| `SAFEPOCKET_AI_PROVIDER`, `SAFEPOCKET_AI_MODEL`, `SAFEPOCKET_AI_MODEL_SNAPSHOT`, `SAFEPOCKET_AI_ENDPOINT` | Override defaults when deploying custom models or gateways. |
| `SAFEPOCKET_KMS_DATA_KEY` | Base64-encoded 256-bit key required to encrypt Plaid access tokens. **Mandatory in production.** |

## Optional / Ops

- `ADMIN_SQL_TOKEN` – shared secret to guard Lambda maintenance endpoints (e.g., `/maint/*`).
- `CONFIG_BUMP` – set by CI to force Lambda to reload configuration (timestamp value).
- `SAFEPOCKET_CHAT_RETENTION_DAYS`, `SAFEPOCKET_CHAT_CLEANUP_CRON` – override chat retention policy.
- `SAFEPOCKET_USE_COGNITO` – usually set via task definition, but can be provided as a secret for convenience.

## Verification

After provisioning secrets and a successful deployment, validate Cognito connectivity:

```bash
curl -X POST https://api.safepocket.app/auth/token \
  -H 'Content-Type: application/json' \
  -d '{
        "grantType": "authorization_code",
        "code": "dummy",
        "redirectUri": "safepocket://auth/callback",
        "codeVerifier": "dummy"
      }'
```

- ✅ Expected failure: `INVALID_CODE` (or similar) means Cognito domain/client values are wired correctly.
- ❌ Error mentioning missing domain/secret → secrets not injected or names mismatched.

## Troubleshooting

1. Review GitHub Actions logs (`main` workflow). Ensure the “Preflight required backend env vars” step passes.
2. Confirm secrets exist under repository settings and match the exact names.
3. Inspect Lambda environment and ECS task definition values:
   ```bash
   aws lambda get-function-configuration --function-name <name> --query 'Environment.Variables' --output json
   aws ecs describe-task-definition --task-definition safepocket-ledger-svc \
     --query 'taskDefinition.containerDefinitions[0].environment' --output table
   ```
4. When updating secrets, redeploy or bump `CONFIG_BUMP` so Lambda refreshes its cached configuration.
