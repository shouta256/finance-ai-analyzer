#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${1:-infra/compose/docker-compose.yml}
SERVICE=${2:-postgres}
ATTEMPTS=${3:-30}
SLEEP_SECONDS=${4:-2}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if docker compose -f "$COMPOSE_FILE" ps "$SERVICE" >/dev/null 2>&1; then
    if docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" pg_isready -U safepocket >/dev/null 2>&1; then
      exit 0
    fi
  fi
  sleep "$SLEEP_SECONDS"
  echo "Waiting for $SERVICE to become ready ($attempt/$ATTEMPTS)..."
done

echo "Timed out waiting for $SERVICE to become ready" >&2
exit 1
