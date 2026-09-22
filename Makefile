# SyncPage — common Docker / ops shortcuts
# Usage: make help

SHELL := /bin/bash
.DEFAULT_GOAL := help

ENV_FILE ?= .env

# اگه کاربر به docker.sock دسترسی نداشت، با sudo می‌ریم جلو
DOCKER ?= $(shell docker info >/dev/null 2>&1 && echo docker || echo "sudo docker")
COMPOSE_MASTER := $(DOCKER) compose -f docker-compose.master.yml --env-file $(ENV_FILE)
# ریموت: host network | هم‌محل: bridge — از EDGE_NETWORK_MODE/.env می‌خونه
NODE_COMPOSE_FILE := $(shell \
  if [ -f "$(ENV_FILE)" ] && grep -q '^EDGE_NETWORK_MODE=host' "$(ENV_FILE)" 2>/dev/null; then \
    echo docker-compose.node.remote.yml; \
  elif [ -f "$(ENV_FILE)" ] && grep -q '^COMPOSE_FILE=' "$(ENV_FILE)" 2>/dev/null; then \
    grep '^COMPOSE_FILE=' "$(ENV_FILE)" | head -1 | cut -d= -f2-; \
  else \
    echo docker-compose.node.yml; \
  fi)
COMPOSE_NODE   := $(DOCKER) compose -f $(NODE_COMPOSE_FILE) --env-file $(ENV_FILE)
COMPOSE_DEV    := $(DOCKER) compose -f docker-compose.dev.yml

.PHONY: help \
	master-up master-down master-down-v master-restart master-build master-logs master-ps master-pull \
	node-up node-down node-down-v node-restart node-build node-logs node-ps \
	local-up local-down local-down-v local-restart local-build local-logs local-ps \
	dev dev-down dev-down-v dev-restart dev-build dev-logs dev-ps \
	smoke master-shell node-shell

help: ## Show available targets
	@echo "SyncPage Makefile"
	@echo ""
	@echo "Development (hot-reload): make dev       | dev-down    | dev-down-v    | dev-logs    | dev-build"
	@echo "Master (production):      make master-up | master-down | master-down-v | master-logs | master-build"
	@echo "Edge node:                make node-up   | node-down   | node-down-v   | node-logs   | node-build"
	@echo "  (compose file: $(NODE_COMPOSE_FILE) — set EDGE_NETWORK_MODE=host for remote)"
	@echo "Combined prod-like stack: make local-up  | local-down  | local-down-v  | local-logs  | smoke"
	@echo ""
	@echo "ENV_FILE default: $(ENV_FILE)  (override: make master-up ENV_FILE=.env.prod)"
	@echo "DOCKER binary:    $(DOCKER)  (override: make master-ps DOCKER='sudo docker')"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

# ----- Master (docker-compose.master.yml) -----

master-up: ## Start Master stack (detached)
	$(COMPOSE_MASTER) up -d

master-down: ## Stop Master stack
	$(COMPOSE_MASTER) down

master-down-v: ## Stop Master stack and remove volumes
	$(COMPOSE_MASTER) down -v

master-restart: ## Restart Master stack
	$(COMPOSE_MASTER) up -d --force-recreate

master-build: ## Build and start Master stack
	$(COMPOSE_MASTER) up -d --build

master-logs: ## Tail Master logs
	$(COMPOSE_MASTER) logs -f

master-ps: ## Show Master container status
	$(COMPOSE_MASTER) ps

master-pull: ## Pull images used by Master stack
	$(COMPOSE_MASTER) pull

master-shell: ## Shell into Master app container
	$(COMPOSE_MASTER) exec app sh

# ----- Edge node (docker-compose.node.yml) -----

node-up: ## Start Edge node stack (detached)
	$(COMPOSE_NODE) up -d

node-down: ## Stop Edge node stack
	$(COMPOSE_NODE) down

node-down-v: ## Stop Edge node stack and remove volumes
	$(COMPOSE_NODE) down -v

node-restart: ## Restart Edge node stack
	$(COMPOSE_NODE) up -d --force-recreate

node-build: ## Build and start Edge node stack
	$(COMPOSE_NODE) up -d --build

node-logs: ## Tail Edge node logs
	$(COMPOSE_NODE) logs -f

node-ps: ## Show Edge node container status
	$(COMPOSE_NODE) ps

node-shell: ## Shell into Edge app container
	$(COMPOSE_NODE) exec app sh

# ----- Local combined stack (Master + Edge) -----

local-up: ## Start Master and Edge stacks together
	$(COMPOSE_MASTER) up -d --build
	$(COMPOSE_NODE) up -d --build

local-down: ## Stop Master and Edge stacks
	$(COMPOSE_NODE) down
	$(COMPOSE_MASTER) down

local-down-v: ## Stop Master and Edge stacks and remove volumes
	$(COMPOSE_NODE) down -v
	$(COMPOSE_MASTER) down -v

local-restart: ## Restart Master and Edge stacks
	$(COMPOSE_MASTER) up -d --force-recreate
	$(COMPOSE_NODE) up -d --force-recreate

local-build: ## Rebuild Master and Edge stacks
	$(COMPOSE_MASTER) build
	$(COMPOSE_NODE) build

local-logs: ## Tail Master stack logs
	$(COMPOSE_MASTER) logs -f

local-ps: ## Show container status for Master and Edge
	@echo "=== Master Stack ==="
	@$(COMPOSE_MASTER) ps
	@echo "=== Edge Stack ==="
	@$(COMPOSE_NODE) ps

# ----- Development stack with Hot-Reload (docker-compose.dev.yml) -----

dev: ## Start local dev stack with hot-reload and isolated DBs
	$(COMPOSE_DEV) up -d --build --force-recreate --remove-orphans

dev-down: ## Stop local dev stack
	$(COMPOSE_DEV) down

dev-down-v: ## Stop local dev stack and wipe volumes
	$(COMPOSE_DEV) down -v

dev-restart: ## Restart local dev stack
	$(COMPOSE_DEV) up -d --force-recreate

dev-build: ## Rebuild dev stack images
	$(COMPOSE_DEV) build

dev-logs: ## Tail all dev logs (or make dev-logs s=app-master)
	$(COMPOSE_DEV) logs -f $(s)

dev-ps: ## Show dev container status
	$(COMPOSE_DEV) ps

smoke: ## Run local smoke test script
	bash scripts/smoke-test.sh
