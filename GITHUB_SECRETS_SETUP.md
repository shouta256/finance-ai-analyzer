# GitHub Secrets設定手順

## ⚠️ 必須: 以下のSecretsをGitHubリポジトリに追加してください

https://github.com/shouta256/finance-ai-analyzer/settings/secrets/actions

### iOS/ネイティブアプリ用のCognito設定

以下の3つのSecretを追加：

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

## デプロイ手順

1. 上記のSecretsを追加
2. このブランチをmainにプッシュ：
   ```bash
   git push origin main
   ```
3. GitHub Actionsが自動的にデプロイを実行
4. デプロイ完了後（約5-10分）、iOSアプリでログインをテスト

## 確認方法

デプロイ完了後、以下のコマンドでテスト：

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

期待される結果：
- ❌ `"reason": "Cognito domain not configured"` → Secrets未設定
- ✅ その他のエラー（INVALID_CODE等） → Secrets設定済み（正常）

## トラブルシューティング

### Secretsが反映されない場合
1. GitHub Actionsのログを確認: https://github.com/shouta256/finance-ai-analyzer/actions
2. "Preflight required backend env vars" ステップでエラーが出ていないか確認
3. ECSタスクの環境変数を確認:
   ```bash
   aws ecs describe-task-definition \
     --task-definition safepocket-ledger-svc \
     --query 'taskDefinition.containerDefinitions[0].environment' \
     --output table
   ```

### デプロイが失敗する場合
- GitHub Actionsのログを確認
- Secretsの名前が正確に一致しているか確認（大文字小文字も）
- Secretsの値に余分なスペースや改行が含まれていないか確認
