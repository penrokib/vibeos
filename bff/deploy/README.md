# vibeos BFF — Scaleway k3s Deploy Runbook

All deploys run from **Roki's M3** with Scaleway kubeconfig active.
Never apply from CI or M1. (Rule: `feedback-m3-owns-deploy.md`)

---

## Prerequisites

| Requirement | Check |
|---|---|
| `kubectl` configured for Scaleway k3s | `kubectl cluster-info` |
| Scaleway registry login | `scw container registry login --region fr-par` |
| `cert-manager` installed on cluster | `kubectl get pods -n cert-manager` |
| `letsencrypt-prod` ClusterIssuer exists | `kubectl get clusterissuer letsencrypt-prod` |
| Traefik installed (k3s default) | `kubectl get pods -n kube-system | grep traefik` |
| Secret `vibeos-bff-secrets` created | `kubectl get secret vibeos-bff-secrets -n vibeos-prod` |

---

## First-Time Setup

### 1. Create the namespace
```bash
kubectl apply -f bff/k8s/namespace.yaml
```

### 2. Create the secret (once, on M3, never committed)
```bash
kubectl create secret generic vibeos-bff-secrets \
  --namespace vibeos-prod \
  --from-literal=JWT_SECRET='<strong-64-char-random>' \
  --from-literal=AUTH_TOKEN_TTL='7d' \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/vibeos' \
  --from-literal=INTERNAL_API_SECRET='<strong-random>' \
  --from-literal=CORS_ORIGIN='https://vibeos.app,https://app.rokibrain.com' \
  --from-literal=APNS_TEAM_ID='<Apple-Team-ID>' \
  --from-literal=APNS_KEY_ID='<Apple-Key-ID>' \
  --from-literal=APNS_PRIVATE_KEY='<base64-p8>'
```
See `bff/k8s/secrets.example.yaml` for all key descriptions.

### 3. Build and push image
```bash
cd ~/Projects/vibeos
./bff/deploy/build-and-push.sh
```

### 4. Apply all manifests
```bash
cd ~/Projects/vibeos
./bff/deploy/apply.sh
```

### 5. Verify
```bash
kubectl rollout status deployment/vibeos-bff -n vibeos-prod
curl https://vibeos.app/health
# Expected: {"status":"ok","service":"bff","ts":"2026-..."}
```

---

## Subsequent Deploys (after initial setup)

```bash
cd ~/Projects/vibeos

# 1. Build new image from HEAD
./bff/deploy/build-and-push.sh

# 2. Pin the deployment to the specific SHA tag (safer than :latest)
GIT_SHA=$(git rev-parse --short HEAD)
kubectl set image deployment/vibeos-bff \
  bff=rg.fr-par.scw.cloud/vibeos/bff:${GIT_SHA} \
  -n vibeos-prod

# 3. Monitor rollout
kubectl rollout status deployment/vibeos-bff -n vibeos-prod
```

---

## Rollback

```bash
# Immediate rollback to previous revision
kubectl rollout undo deployment/vibeos-bff -n vibeos-prod

# Rollback to a specific revision
kubectl rollout history deployment/vibeos-bff -n vibeos-prod
kubectl rollout undo deployment/vibeos-bff --to-revision=<N> -n vibeos-prod
```

---

## HPA (Horizontal Pod Autoscaler) — v1.1

The HPA manifest is staged at `bff/k8s/hpa.yaml` but NOT applied in v1.0.
Enable once metrics-server is installed and traffic baseline is established:

```bash
# Install metrics-server (if not present)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Verify
kubectl top pods -n vibeos-prod

# Apply HPA (scales 1-5 replicas at 70% CPU)
kubectl apply -f bff/k8s/hpa.yaml
```

---

## Rotating Secrets

```bash
kubectl create secret generic vibeos-bff-secrets \
  --namespace vibeos-prod \
  --from-literal=JWT_SECRET='<new-value>' \
  --from-literal=... \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/vibeos-bff -n vibeos-prod
```

---

## Dry-Run Mode

Both scripts support `--dry-run` for syntax/logic checks without touching the cluster:

```bash
./bff/deploy/build-and-push.sh --dry-run
./bff/deploy/apply.sh --dry-run
```

---

## Troubleshooting

```bash
# Pod logs
kubectl logs -f deployment/vibeos-bff -n vibeos-prod

# Pod events (useful for image pull errors, OOM, etc.)
kubectl describe pod -l app=vibeos-bff -n vibeos-prod

# Check TLS cert status
kubectl describe certificate vibeos-app-tls -n vibeos-prod

# Force redeploy without image change (picks up new secret values)
kubectl rollout restart deployment/vibeos-bff -n vibeos-prod
```
