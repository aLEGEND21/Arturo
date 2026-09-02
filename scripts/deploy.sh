#!/usr/bin/env bash
# Runs ON the VPS. Brings the compose stack up on the given image tag,
# health-checks the full chain (frontend proxy -> backend), and automatically
# falls back to the previous release if it won't serve.
#
# Usage: deploy.sh <image-tag>
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
STATE_DIR="/opt/arturo"

cd "$STATE_DIR"
CURRENT="$(cat current 2>/dev/null || true)"

start_stack() {
  TAG="$1" docker compose -f docker-compose.prod.yml up -d --remove-orphans
}

healthy() {
  # /health on the frontend is rewritten to the backend, so one probe
  # verifies both containers and the network between them.
  for _ in $(seq 1 30); do
    if docker exec arturo-frontend wget -qO /dev/null http://localhost:3000/health 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "Deploying arturo:$TAG"
start_stack "$TAG"

if ! healthy; then
  echo "Health check failed for arturo:$TAG" >&2
  if [ -n "$CURRENT" ]; then
    echo "Restoring arturo:$CURRENT" >&2
    start_stack "$CURRENT"
  fi
  exit 1
fi

if [ -n "$CURRENT" ] && [ "$CURRENT" != "$TAG" ]; then
  echo "$CURRENT" > previous
fi
echo "$TAG" > current

# Prune all release images except current and previous.
PREVIOUS="$(cat previous 2>/dev/null || echo none)"
for IMAGE in arturo-backend arturo-frontend; do
  docker images "$IMAGE" --format '{{.Tag}}' |
    grep -v -e "^$TAG$" -e "^$PREVIOUS$" |
    xargs -r -I{} docker rmi "$IMAGE:{}" > /dev/null 2>&1 || true
done

echo "Deployed arturo:$TAG"
