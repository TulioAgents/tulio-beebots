# beebots, all local, no Docker. `make dev` runs the engine and the dashboard together.
#
#   make install    install both workspaces
#   make dev        engine on :8080 + dashboard on :5173 (Ctrl-C stops both)
#   make stop       kill whatever is still holding :8080 or :5173
#   make reset      wipe the paper books: next run starts at day 1, $333 a bee
#   make demo       engine in MODE=demo (real orders on OKX demo) + dashboard
#   make keycheck   check the OKX demo keys in .env before running demo
#   make engine     engine only
#   make dashboard  dashboard only
#   make e2e        the whole engine on paper with a fake Jev (no keys, no spend)
#   make check      typecheck, lint and tests
#
# The engine needs Node >= 22.13 for node:sqlite. If your shell's node is older, this
# Makefile uses the nvm-installed one below instead, so you never have to switch first.

SHELL := /bin/bash
NODE_VERSION := 22.13.1
NVM_NODE := $(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin
PORTS := 8080 5173

# GNU Make 3.81 (the macOS default) runs a simple recipe line without a shell and ignores
# an exported PATH, so each command carries its own PATH instead of relying on `export`.
ifneq ($(wildcard $(NVM_NODE)/node),)
N := PATH="$(NVM_NODE):$$PATH"
endif

.PHONY: help node ports stop reset demo demo-engine keycheck install dev engine dashboard e2e check test typecheck lint

help:
	@sed -n '2,13p' Makefile | cut -c3-

# Fails with a readable message instead of dying inside tsx with ERR_UNKNOWN_BUILTIN_MODULE.
node:
	@$(N) node -e 'const v = process.versions.node.split(".").map(Number); if (v[0] < 22 || (v[0] === 22 && v[1] < 13)) { console.error("node " + process.versions.node + " is too old. The engine needs node >= 22.13 for node:sqlite."); console.error("Install it with:  nvm install $(NODE_VERSION)"); process.exit(1); }'

# A leftover run holding :8080 makes the new engine die on EADDRINUSE while the old one keeps
# serving the dashboard, which looks like the new code working. Fail before that can confuse anyone.
ports:
	@busy=""; \
	for p in $(PORTS); do \
	pid=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN -t 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then echo "port $$p is held by PID $$pid ($$(ps -p $$pid -o comm= 2>/dev/null | xargs))"; busy=1; fi; \
	done; \
	if [ -n "$$busy" ]; then echo "run 'make stop' first, or Ctrl-C the other 'make dev'."; exit 1; fi

stop:
	@for p in $(PORTS); do \
	pid=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN -t 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then echo "stopping PID $$pid on :$$p"; kill $$pid; fi; \
	done; \
	sleep 1; echo "ports $(PORTS) free"

install: node
	@$(N) pnpm install
	@cd dashboard && $(N) pnpm install

dev: node ports
	@echo "starting engine (it loads market data before it listens, ~15s)..."
	@trap 'kill 0' EXIT INT TERM; \
	$(MAKE) --no-print-directory engine & epid=$$!; \
	up=""; \
	for i in $$(seq 1 120); do \
	  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8080/health; then up=1; break; fi; \
	  if ! kill -0 $$epid 2>/dev/null; then echo "engine exited before it came up - see its error above"; exit 1; fi; \
	  sleep 0.5; \
	done; \
	if [ -z "$$up" ]; then echo "engine did not listen on :8080 within 60s"; exit 1; fi; \
	echo ""; \
	echo "engine up. dashboard -> http://localhost:5173  (Ctrl-C stops both)"; \
	$(MAKE) --no-print-directory dashboard & \
	wait

# Local dev is always paper: pinned here so a MODE=demo/live line in .env cannot leak into it.
# Shell env beats --env-file, so these win. Use `pnpm dev` directly if you want .env's own mode.
engine: node
	@$(N) DRY_RUN=true MODE=dry pnpm dev

# --strictPort: fail loudly rather than sliding to :5174, where the page would quietly
# proxy to whatever else is on :8080.
dashboard: node
	@cd dashboard && $(N) pnpm dev --strictPort

e2e: node
	@$(N) pnpm e2e:fake-jev

check: typecheck lint test

test: node
	@$(N) pnpm test

typecheck: node
	@$(N) pnpm typecheck

lint: node
	@$(N) pnpm lint

# Wipes one mode's books so the next run starts fresh: day 1, $333 a bee, no decisions.
# Keeps .env, Setup choices (data/settings.json) and Hive membership (data/hive.json).
# Another mode:  make reset RESET_MODE=demo
RESET_MODE := dry
reset: stop
	@found=$$(ls -1 data/bees-$(RESET_MODE).sqlite* data/close-$(RESET_MODE) data/resume-last-$(RESET_MODE) 2>/dev/null); \
	if [ -z "$$found" ]; then echo "nothing to delete for mode '$(RESET_MODE)'"; exit 0; fi; \
	echo "deleting:"; echo "$$found" | sed 's/^/  /'; \
	echo "$$found" | tr '\n' '\0' | xargs -0 rm; \
	echo "done - next 'make dev' starts from zero"

# OKX demo exchange: real orders against OKX's demo account, play money, its own books in
# data/bees-demo.sqlite. Needs BEE1/2/3_OKX_DEMO_API_KEY, _SECRET and _PASSPHRASE in .env.
# Check them first with `make keycheck`.
demo: node ports
	@echo "starting engine MODE=demo (real orders on OKX demo)..."
	@trap 'kill 0' EXIT INT TERM; \
	$(MAKE) --no-print-directory demo-engine & epid=$$!; \
	up=""; \
	for i in $$(seq 1 120); do \
	  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8080/health; then up=1; break; fi; \
	  if ! kill -0 $$epid 2>/dev/null; then echo "engine exited before it came up - run 'make keycheck'"; exit 1; fi; \
	  sleep 0.5; \
	done; \
	if [ -z "$$up" ]; then echo "engine did not listen on :8080 within 60s"; exit 1; fi; \
	echo ""; \
	echo "engine up. dashboard -> http://localhost:5173  (Ctrl-C stops both)"; \
	$(MAKE) --no-print-directory dashboard & \
	wait

demo-engine: node
	$(N) DRY_RUN=false MODE=demo pnpm dev

keycheck: node
	$(N) KEYCHECK_ONLY=demo pnpm keycheck
