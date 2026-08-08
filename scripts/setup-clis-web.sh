#!/usr/bin/env bash
# Baudrier cloud environment setup script - pasted into the claude.ai/code
# "Baudrier" environment (README, "Installation" chapter). Runs once as root at snapshot
# build; must always exit 0 (a non-zero exit aborts the environment build).
# The explicit plugin install below is the only path that works on web:
# the settings.json auto-install is half-broken (CONTRACT.md, section 1).

log() { printf '[baudrier-setup] %s\n' "$*"; }
log "starting"

# Node ignores the sandbox egress proxy by default, so node fetch() traffic
# leaves through a different address pool than curl (verified live 2026-08-08,
# CONTRACT.md, section 1). NODE_USE_ENV_PROXY (node >= 22.18) makes fetch()
# honor HTTPS_PROXY; the proxy CA is already trusted via the platform's global
# NODE_EXTRA_CA_CERTS. Exported in the profile so every session shell has it.
log "enabling Node proxy support (NODE_USE_ENV_PROXY)..."
export NODE_USE_ENV_PROXY=1
for f in "$HOME/.bashrc" "$HOME/.profile"; do
  grep -q 'NODE_USE_ENV_PROXY' "$f" 2>/dev/null && continue
  printf 'export NODE_USE_ENV_PROXY=1\n' >> "$f" || log "$f export failed (non-fatal)."
done

log "adding the baudrier marketplace..."
claude plugin marketplace add calopsys/baudrier || log "marketplace add failed (non-fatal)."
log "installing the baudrier plugin..."
claude plugin install baudrier@baudrier || log "plugin install failed (non-fatal)."

BOOTSTRAP_DEPS="$(find "$HOME/.claude/plugins" -type f -path '*/tools/bootstrap-deps.mjs' 2>/dev/null | head -1)"
if [ -n "$BOOTSTRAP_DEPS" ]; then
  log "running $BOOTSTRAP_DEPS..."
  node "$BOOTSTRAP_DEPS" || log "bootstrap-deps.mjs failed (non-fatal)."
else
  log "bootstrap-deps.mjs not found (non-fatal)."
fi

log "starting dockerd..."
dockerd >/tmp/dockerd-setup.log 2>&1 &
WAITED=0
while [ "$WAITED" -lt 40 ] && ! docker info >/dev/null 2>&1; do
  sleep 1
  WAITED=$((WAITED + 1))
done
if docker info >/dev/null 2>&1; then
  log "dockerd up after ${WAITED}s; pulling node:24-alpine..."
  docker pull node:24-alpine || log "docker pull failed (non-fatal)."
else
  log "dockerd did not come up within 40s (non-fatal)."
fi

log "done"
exit 0
