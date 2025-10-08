SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM := pnpm
GRADLEW := ./apps/ledger-svc/gradlew

export SAFEPOCKET_DEV_JWT_SECRET ?= local-dev-shared-secret-change-me-32
export SAFEPOCKET_USE_COGNITO ?= false
COMPOSE_FILE ?= infra/compose/docker-compose.yml
DOCKER_COMPOSE ?= docker compose

# Load root .env (if present) so make targets propagate shared environment vars
ifneq (,$(wildcard .env))
include .env
export $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env)
endif

.PHONY: help setup pnpm-install generate-types backend-build docker-up wait-for-db seed up down logs clean kill-port

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' Makefile | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: pnpm-install generate-types backend-build seed ## Install deps, build artifacts, start infra, seed database
	@echo "Setup complete."

pnpm-install: ## Install web dependencies with pnpm
	$(PNPM) -C apps/web install

generate-types: ## Generate API typings from OpenAPI
	$(PNPM) -C apps/web generate:api

backend-build: ## Compile Spring Boot service and download dependencies
	$(GRADLEW) -p apps/ledger-svc build

DockerUpTargets := postgres redis

docker-up: ## Boot local infrastructure (Postgres/Redis) via docker compose
	$(DOCKER_COMPOSE) -f $(COMPOSE_FILE) up -d $(DockerUpTargets)

wait-for-db: docker-up ## Wait until Postgres is accepting connections
	./scripts/wait-for-db.sh $(COMPOSE_FILE) postgres 30 2

seed: wait-for-db ## Apply SQL seed data to Postgres
	./scripts/seed-db.sh $(COMPOSE_FILE)

up: docker-up ## Start backend and frontend in dev mode (Ctrl+C to stop)
	@echo "Launching Safepocket services..."
	@trap 'kill 0' INT TERM EXIT; \
	  (cd apps/ledger-svc && ./gradlew bootRun) & \
	  (cd apps/web && $(PNPM) dev) & \
	  wait

down: ## Stop app processes and supporting containers
	@echo "Stopping services..."
	@pkill -f "apps/ledger-svc/gradlew bootRun" 2>/dev/null || true
	@pkill -f "pnpm dev" 2>/dev/null || true
	$(DOCKER_COMPOSE) -f $(COMPOSE_FILE) down

logs: ## Tail docker compose logs
	$(DOCKER_COMPOSE) -f $(COMPOSE_FILE) logs -f

clean: ## Stop containers and remove generated artifacts
	$(DOCKER_COMPOSE) -f $(COMPOSE_FILE) down -v
	rm -rf apps/ledger-svc/build
	rm -rf apps/web/.next apps/web/node_modules apps/web/src/lib/api-types.ts

kill-port: ## Kill process listening on port 8081 (macOS/Linux)
	@PORT=8081; \
	PID=$$(lsof -ti tcp:$$PORT || true); \
	if [ -n "$$PID" ]; then \
	  echo "Killing process $$PID on port $$PORT"; kill $$PID; else echo "No process on port $$PORT"; fi
