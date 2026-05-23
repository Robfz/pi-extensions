#!/usr/bin/env bash
#
# apply-settings.sh
#
# Deep-merge the curated settings in this repo into ~/.pi/agent/settings.json,
# preserving any keys pi has written there that we don't track (e.g.
# lastChangelogVersion). Idempotent.
#
# Requires: jq

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURATED="$REPO_DIR/settings/settings.json"
LIVE="${PI_SETTINGS:-$HOME/.pi/agent/settings.json}"

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }
[ -f "$CURATED" ] || { echo "error: missing $CURATED" >&2; exit 1; }

mkdir -p "$(dirname "$LIVE")"
[ -f "$LIVE" ] || echo "{}" > "$LIVE"

# Validate both inputs as JSON before touching the live file.
jq -e . "$CURATED" >/dev/null
jq -e . "$LIVE" >/dev/null

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Deep merge: curated wins on conflict, live keys we don't track are preserved.
jq -s '.[0] * .[1]' "$LIVE" "$CURATED" > "$tmp"

if cmp -s "$tmp" "$LIVE"; then
  echo "settings unchanged: $LIVE"
else
  cp "$LIVE" "$LIVE.bak"
  mv "$tmp" "$LIVE"
  trap - EXIT
  echo "merged: $CURATED -> $LIVE (backup at $LIVE.bak)"
fi
