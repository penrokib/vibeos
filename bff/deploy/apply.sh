#!/usr/bin/env bash
# bff/deploy/apply.sh
# Apply vibeos BFF k8s manifests to the Scaleway k3s cluster.
#
# Run from M3 (Roki's machine) with Scaleway kubeconfig active.
# DO NOT run from CI. DO NOT apply against any cluster automatically.
# Roki applies manually after reviewing the PR (per M3-owns-deploy rule).
#
# Usage:
#   ./bff/deploy/apply.sh               # apply all manifests
#   ./bff/deploy/apply.sh --dry-run      # kubectl --dry-run=client (syntax check only)
#
# Must be invoked from the monorepo ROOT (not bff/):
#   cd ~/Projects/vibeos && ./bff/deploy/apply.sh

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
K8S_DIR="bff/k8s"
NAMESPACE="vibeos-prod"

# ─── Flags ───────────────────────────────────────────────────────────────────
DRY_RUN=false
KUBECTL_EXTRA_FLAGS=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
    KUBECTL_EXTRA_FLAGS+=("--dry-run=client")
  fi
done

# ─── Helpers ─────────────────────────────────────────────────────────────────
kctl() {
  echo "+ kubectl ${KUBECTL_EXTRA_FLAGS[*]:-} $*"
  kubectl "${KUBECTL_EXTRA_FLAGS[@]:-}" "$@"
}

info() { echo "==> $*"; }
error() { echo "ERROR: $*" >&2; exit 1; }

# ─── Guard: must be run from monorepo root ────────────────────────────────────
if [[ ! -f "bff/package.json" ]]; then
  error "Must be run from the vibeos monorepo root (cd ~/Projects/vibeos first)"
fi

# ─── Guard: kubectl must be configured ───────────────────────────────────────
if ! kubectl cluster-info &>/dev/null; then
  error "kubectl cannot reach the cluster. Check KUBECONFIG or run: scw k8s kubeconfig install <cluster-id>"
fi

info "vibeos BFF — kubectl apply"
CONTEXT=$(kubectl config current-context 2>/dev/null || echo "unknown")
info "Cluster context : ${CONTEXT}"
if $DRY_RUN; then
  echo "  [DRY RUN mode — kubectl --dry-run=client]"
fi
echo ""

# ─── Step 1: Namespace ───────────────────────────────────────────────────────
info "Step 1/5 — Namespace"
kctl apply -f "${K8S_DIR}/namespace.yaml"

# ─── Step 2: Secrets reminder ────────────────────────────────────────────────
info "Step 2/5 — Secrets (pre-flight check)"
if ! $DRY_RUN; then
  if ! kubectl get secret vibeos-bff-secrets -n "${NAMESPACE}" &>/dev/null; then
    echo ""
    echo "  [BLOCKED] Secret 'vibeos-bff-secrets' not found in namespace '${NAMESPACE}'."
    echo "  Create it before applying the Deployment (see bff/k8s/secrets.example.yaml):"
    echo ""
    echo "    kubectl create secret generic vibeos-bff-secrets \\"
    echo "      --namespace ${NAMESPACE} \\"
    echo "      --from-literal=JWT_SECRET='...' \\"
    echo "      --from-literal=DATABASE_URL='...' \\"
    echo "      --from-literal=INTERNAL_API_SECRET='...' \\"
    echo "      --from-literal=AUTH_TOKEN_TTL='7d' \\"
    echo "      --from-literal=CORS_ORIGIN='https://vibeos.app'"
    echo ""
    error "Secret missing — aborting to prevent CrashLoopBackOff."
  fi
  echo "  Secret 'vibeos-bff-secrets' found — OK"
fi

# ─── Step 3: Deployment ──────────────────────────────────────────────────────
info "Step 3/5 — Deployment"
kctl apply -f "${K8S_DIR}/deployment.yaml"

# ─── Step 4: Service ─────────────────────────────────────────────────────────
info "Step 4/5 — Service"
kctl apply -f "${K8S_DIR}/service.yaml"

# ─── Step 5: Ingress ─────────────────────────────────────────────────────────
info "Step 5/5 — Ingress"
kctl apply -f "${K8S_DIR}/ingress.yaml"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
info "All manifests applied."
if ! $DRY_RUN; then
  echo ""
  echo "Monitor rollout:"
  echo "  kubectl rollout status deployment/vibeos-bff -n ${NAMESPACE}"
  echo ""
  echo "Verify health:"
  echo "  curl https://vibeos.app/health"
  echo ""
  echo "Rollback (if needed):"
  echo "  kubectl rollout undo deployment/vibeos-bff -n ${NAMESPACE}"
fi
