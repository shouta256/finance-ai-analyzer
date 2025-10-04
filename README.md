# Safepocket

## ヘルスチェック / Health Checks

### Backend (ledger-svc)
- Liveness: `GET /actuator/health/liveness`  
  - DB 接続が確立していなくても `UP` を返すように起動継続 (Hikari 初期失敗で停止しない設定: `initializationFailTimeout=0`).  
  - ALB / ECS Target Group のヘルスチェック推奨。
- Readiness: `GET /actuator/health/readiness`  
  - DB など依存コンポーネントを含む総合判定。正常起動後に `UP`。
- 全体: `GET /actuator/health` (Spring Boot 標準)  

### Frontend (web)
- Simple Health: `GET /api/healthz`  
  - 軽量 JSON: `{ "status": "ok" }`  
  - ALB Target Group / 外形監視に利用。

## Runtime Ports
- Frontend: 3000 (0.0.0.0 bind)
- Backend: 8081 (0.0.0.0 bind)

## Docker HEALTHCHECK
`apps/ledger-svc/Dockerfile` にて liveness を利用:
```
HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD curl -fsS http://localhost:8081/actuator/health/liveness || exit 1
```

## 環境変数 (DB Credentials / Connection)
Backend の `application.yml` は以下の環境変数で上書き可能:
- `SPRING_DATASOURCE_URL` (default: `jdbc:postgresql://localhost:5432/app`)
- `SPRING_DATASOURCE_USERNAME` (default: `app`)
- `SPRING_DATASOURCE_PASSWORD` (default: `app`)

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

