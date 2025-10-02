#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${1:-infra/compose/docker-compose.yml}
SQL_PATH=${2:-/docker-entrypoint-initdb.d/seed/seed.sql}

if ! docker compose -f "$COMPOSE_FILE" ps postgres >/dev/null 2>&1; then
  echo "Postgres service is not running. Did you run 'docker compose up -d'?" >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U safepocket -d safepocket -v ON_ERROR_STOP=1 -f "$SQL_PATH"
