#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${1:-infra/compose/docker-compose.yml}
SQL_PATH=${2:-/docker-entrypoint-initdb.d/seed/seed.sql}
LOCAL_FALLBACK="scripts/sql/seed.sql"

if ! docker compose -f "$COMPOSE_FILE" ps postgres >/dev/null 2>&1; then
  echo "Postgres service is not running. Did you run 'docker compose up -d'?" >&2
  exit 1
fi

set +e
docker compose -f "$COMPOSE_FILE" exec -T postgres test -f "$SQL_PATH" 2>/dev/null
FOUND=$?
set -e
if [ "$FOUND" -ne 0 ]; then
  if [ -f "$LOCAL_FALLBACK" ]; then
    echo "[seed-db] Container path $SQL_PATH not found. Using local fallback $LOCAL_FALLBACK" >&2
    docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U safepocket -d safepocket -v ON_ERROR_STOP=1 < "$LOCAL_FALLBACK"
    exit 0
  else
    echo "[seed-db] ERROR: neither $SQL_PATH nor local $LOCAL_FALLBACK available" >&2
    exit 1
  fi
fi

docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U safepocket -d safepocket -v ON_ERROR_STOP=1 -f "$SQL_PATH"
