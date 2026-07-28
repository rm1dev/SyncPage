# SyncPage — common Docker / ops shortcuts
# Usage: make help

SHELL := /bin/bash
.DEFAULT_GOAL := help

ENV_FILE ?= .env

# اگه کاربر به docker.sock دسترسی نداشت، با sudo می‌ریم جلو
DOCKER ?= $(shell docker info >/dev/null 2>&1 && echo docker || echo "sudo docker")
COMPOSE_MASTER := $(DOCKER) compose -f docker-compose.master.yml --env-file $(ENV_FILE)
COMPOSE_NODE   := $(DOCKER) compose -f docker-compose.node.yml --env-file $(ENV_FILE)
COMPOSE_LOCAL  := $(DOCKER) compose

.PHONY: help \
	master-up master-down master-down-v master-restart master-build master-logs master-ps master-pull \
	node-up node-down node-down-v node-restart node-build node-logs node-ps \
	local-up local-down local-down-v local-restart local-build local-logs local-ps \
	smoke master-shell node-shell

help: ## Show available targets
	@echo "SyncPage Makefile"
	@echo ""
	@echo "Master (production):  make master-up | master-down | master-down-v | master-logs | master-build"
	@echo "Edge node:            make node-up   | node-down   | node-down-v   | node-logs   | node-build"
	@echo "Local (dev stack):    make local-up  | local-down  | local-down-v  | local-logs  | smoke"
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

# ----- Local development (docker-compose.yml) -----

local-up: ## Start local Master+Edge+nginx stack
	$(COMPOSE_LOCAL) up -d --build

local-down: ## Stop local stack
	$(COMPOSE_LOCAL) down

local-down-v: ## Stop local stack and remove volumes
	$(COMPOSE_LOCAL) down -v

local-restart: ## Restart local stack
	$(COMPOSE_LOCAL) up -d --force-recreate

local-build: ## Rebuild local stack
	$(COMPOSE_LOCAL) up -d --build

local-logs: ## Tail local stack logs
	$(COMPOSE_LOCAL) logs -f

local-ps: ## Show local container status
	$(COMPOSE_LOCAL) ps

smoke: ## Run local smoke test script
	bash scripts/smoke-test.sh
