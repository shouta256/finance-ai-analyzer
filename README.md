# Safepocket

## ヘルスチェック / Health Checks

### Backend (ledger-svc)
- Primary (ALB Target Group): `GET /actuator/health`  
  - Spring Boot aggregate health. DB ダウン時は `DOWN` / 503 を返し ALB から外れる想定。
- Liveness (container internal / debug): `GET /actuator/health/liveness`  
  - DB 未接続でも `UP`。プロセス稼働確認用。
- Readiness: `GET /actuator/health/readiness`  
  - 依存リソース込み判定。

### Frontend (web)
- Simple Health: `GET /api/healthz`  
  - 軽量 JSON: `{ "status": "ok" }`  
  - ALB Target Group / 外形監視に利用。

## Runtime Ports
- Frontend: 3000 (0.0.0.0 bind)
- Backend: 8081 (0.0.0.0 bind)

## Docker HEALTHCHECK
`apps/ledger-svc/Dockerfile` は ALB と合わせ `/actuator/health` を利用:
```
HEALTHCHECK --start-period=45s --interval=30s --timeout=5s --retries=5 CMD curl -fsS http://localhost:8081/actuator/health || exit 1
```

## 環境変数 (DB Credentials / Connection)
Backend の `application.yml` は以下の環境変数で上書き可能:
- `SPRING_DATASOURCE_URL` (default: `jdbc:postgresql://localhost:5432/safepocket`)
- `SPRING_DATASOURCE_USERNAME` (default: `safepocket`)
- `SPRING_DATASOURCE_PASSWORD` (default: `safepocket`)

ECS ではこれらを Secrets Manager / SSM からタスク定義環境変数として注入。

## ローカル起動メモ (抜粋)
1. Infra (DB / Redis) 起動: `docker compose -f infra/compose/docker-compose.yml up -d`
2. Backend: `./apps/ledger-svc/gradlew -p apps/ledger-svc bootRun`
3. Frontend: `pnpm -C apps/web dev`

## 変更概要 (Health Feature)
- Actuator probes 有効化 (`management.endpoint.health.probes.enabled=true`).
- liveness/readiness 導入。liveness は DB 非依存。
- Datasource を環境変数化し、初期失敗で停止しない設定。
- Backend Dockerfile に `HEALTHCHECK` 追加。
- Frontend に `/api/healthz` 追加。
- `next start` を明示的に `0.0.0.0:3000` へバインドするようスクリプト調整。
