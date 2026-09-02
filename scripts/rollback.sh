#!/usr/bin/env bash
# Runs ON the VPS. Swaps the running stack back to the previous release.
#
# Usage: rollback.sh
set -euo pipefail

STATE_DIR="/opt/arturo"
cd "$STATE_DIR"

PREVIOUS="$(cat previous 2>/dev/null || true)"
if [ -z "$PREVIOUS" ]; then
  echo "No previous release recorded in $STATE_DIR/previous" >&2
  exit 1
fi
CURRENT="$(cat current 2>/dev/null || true)"

echo "Rolling back to arturo:$PREVIOUS"
TAG="$PREVIOUS" docker compose -f docker-compose.prod.yml up -d --remove-orphans

# The rolled-back release is now current; keep the old one for rolling forward.
echo "$PREVIOUS" > current
if [ -n "$CURRENT" ]; then
  echo "$CURRENT" > previous
fi

echo "Rolled back to arturo:$PREVIOUS"
