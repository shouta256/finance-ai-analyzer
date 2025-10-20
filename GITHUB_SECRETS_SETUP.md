# GitHub Secrets Setup Guide

## ⚠️ Required Secrets

Add the following secrets to the repository:  
`https://github.com/shouta256/finance-ai-analyzer/settings/secrets/actions`

### Cognito (Native App)

Add these three secrets:

#### 1. COGNITO_DOMAIN
```
Name: COGNITO_DOMAIN
Value: https://us-east-1mfd4o5tgy.auth.us-east-1.amazoncognito.com
```

#### 2. COGNITO_CLIENT_ID_NATIVE
```
Name: COGNITO_CLIENT_ID_NATIVE
Value: p4tu620p2eriv24tb1897d49s
```

#### 3. COGNITO_REDIRECT_URI_NATIVE
```
Name: COGNITO_REDIRECT_URI_NATIVE
Value: safepocket://auth/callback
```

## Deployment Steps

1. Add the secrets above.
2. Push the branch to main:
   ```bash
   git push origin main
   ```
3. GitHub Actions triggers the deployment automatically.
4. After deployment (about 5–10 minutes), test login on the iOS app.

## Verification

Run the following request after the deployment finishes:

```bash
curl -X POST https://api.shota256.me/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grantType": "authorization_code",
    "code": "test_code",
    "redirectUri": "safepocket://auth/callback",
    "codeVerifier": "test_verifier"
  }'
```

Expected results:
- ❌ `"reason": "Cognito domain not configured"` → secrets missing
- ✅ Any other error (INVALID_CODE, etc.) → secrets configured correctly

## Troubleshooting

### Secrets not applied
1. Check GitHub Actions logs: https://github.com/shouta256/finance-ai-analyzer/actions
2. Confirm the “Preflight required backend env vars” step passes.
3. Inspect ECS task definition environment variables:
   ```bash
   aws ecs describe-task-definition \
     --task-definition safepocket-ledger-svc \
     --query 'taskDefinition.containerDefinitions[0].environment' \
     --output table
   ```

### Deployment fails
- Review GitHub Actions logs.
- Ensure secret names match exactly (case-sensitive).
- Confirm there are no trailing spaces or newlines in secret values.
