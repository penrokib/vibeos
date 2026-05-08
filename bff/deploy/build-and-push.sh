#!/usr/bin/env bash
# bff/deploy/build-and-push.sh
# Build the vibeos BFF Docker image and push to Scaleway Container Registry.
#
# Run from M3 (Roki's machine) — DO NOT run from CI.
# Prod credentials must be active (Scaleway registry login, kubeconfig).
#
# Usage:
#   ./bff/deploy/build-and-push.sh               # normal build + push
#   ./bff/deploy/build-and-push.sh --dry-run      # print commands, no execution
#
# Must be invoked from the monorepo ROOT (not bff/):
#   cd ~/Projects/vibeos && ./bff/deploy/build-and-push.sh

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
REGISTRY="rg.fr-par.scw.cloud/vibeos"
IMAGE_NAME="bff"
DOCKERFILE="bff/Dockerfile"
NAMESPACE="vibeos-prod"

# ─── Flags ───────────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  fi
done

# ─── Helpers ─────────────────────────────────────────────────────────────────
run() {
  if $DRY_RUN; then
    echo "[DRY RUN] $*"
  else
    echo "+ $*"
    "$@"
  fi
}

info() { echo "==> $*"; }
error() { echo "ERROR: $*" >&2; exit 1; }

# ─── Guard: must be run from monorepo root ────────────────────────────────────
if [[ ! -f "bff/package.json" ]]; then
  error "Must be run from the vibeos monorepo root (cd ~/Projects/vibeos first)"
fi

# ─── Derive image tags from git SHA ──────────────────────────────────────────
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
TAG_SHA="${REGISTRY}/${IMAGE_NAME}:${GIT_SHA}"
TAG_LATEST="${REGISTRY}/${IMAGE_NAME}:latest"
TAG_TS="${REGISTRY}/${IMAGE_NAME}:${TIMESTAMP}"

info "vibeos BFF — build-and-push"
info "Git SHA  : ${GIT_SHA}"
info "Registry : ${REGISTRY}"
info "Tags     : ${TAG_SHA}  ${TAG_LATEST}  ${TAG_TS}"
if $DRY_RUN; then
  echo "  [DRY RUN mode — no commands executed]"
  echo ""
fi

# ─── Step 1: Scaleway registry login ─────────────────────────────────────────
info "Step 1/4 — Scaleway registry login"
# Requires SCW_SECRET_KEY env var or scw CLI configured.
# Alternatives: docker login rg.fr-par.scw.cloud -u nologin --password-stdin <<< "$SCW_SECRET_KEY"
if ! $DRY_RUN && ! command -v scw &>/dev/null; then
  # Fall back to docker login if scw CLI not installed
  if [[ -z "${SCW_SECRET_KEY:-}" ]]; then
    error "Neither 'scw' CLI nor SCW_SECRET_KEY env var found. Set SCW_SECRET_KEY or install scw CLI."
  fi
  echo "${SCW_SECRET_KEY}" | docker login rg.fr-par.scw.cloud -u nologin --password-stdin
else
  run scw container registry login --region fr-par 2>/dev/null || \
    run docker login rg.fr-par.scw.cloud -u nologin --password-stdin <<< "${SCW_SECRET_KEY:-PLACEHOLDER}"
fi

# ─── Step 2: Docker build ─────────────────────────────────────────────────────
info "Step 2/4 — Docker build (context: monorepo root)"
run docker build \
  --file "${DOCKERFILE}" \
  --tag "${TAG_SHA}" \
  --tag "${TAG_LATEST}" \
  --tag "${TAG_TS}" \
  --label "org.opencontainers.image.revision=${GIT_SHA}" \
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --label "org.opencontainers.image.source=https://github.com/penrokib/vibeos" \
  .

# ─── Step 3: Push all tags ────────────────────────────────────────────────────
info "Step 3/4 — Pushing tags to Scaleway registry"
run docker push "${TAG_SHA}"
run docker push "${TAG_LATEST}"
run docker push "${TAG_TS}"

# ─── Step 4: Report ──────────────────────────────────────────────────────────
info "Step 4/4 — Done"
echo ""
echo "Image tags pushed:"
echo "  ${TAG_SHA}"
echo "  ${TAG_LATEST}"
echo "  ${TAG_TS}"
echo ""
echo "Next: update deployment image tag and run apply.sh (or let apply.sh use :latest)."
echo "  kubectl set image deployment/vibeos-bff bff=${TAG_SHA} -n ${NAMESPACE}"
