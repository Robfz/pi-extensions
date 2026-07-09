#!/usr/bin/env bash
#
# doctor.sh
#
# Verify the symlink wiring between this repo and ~/.pi/agent/:
#
#   1. Every repo entry (extensions/agents/skills/themes/prompts, plus
#      APPEND_SYSTEM.md) has a symlink under ~/.pi/agent/ pointing at it.
#   2. Every entry inside ~/.pi/agent/<kind>/ is a symlink into this repo —
#      flags real files, broken symlinks, and symlinks pointing elsewhere.
#
# Exits 0 when everything checks out, 1 otherwise. Fix problems with
# scripts/link.sh (or by hand for real-file conflicts).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
KINDS="extensions agents skills themes prompts"

problems=0

check_link() { # $1=expected source (repo), $2=live path
  local src="$1" dst="$2"
  if [ ! -L "$dst" ]; then
    if [ -e "$dst" ]; then
      echo "conflict: $dst exists but is not a symlink"
    else
      echo "missing:  $dst (run scripts/link.sh)"
    fi
    problems=$((problems + 1))
  elif [ "$(readlink "$dst")" != "$src" ]; then
    echo "wrong:    $dst -> $(readlink "$dst") (expected $src)"
    problems=$((problems + 1))
  fi
}

# 1. Repo -> live: every tracked entry must be linked.
for kind in $KINDS; do
  src_dir="$REPO_DIR/$kind"
  [ -d "$src_dir" ] || continue
  for src in "$src_dir"/*; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    [ "$name" = "README.md" ] && continue
    check_link "$src" "$AGENT_DIR/$kind/$name"
  done
done
[ -f "$REPO_DIR/APPEND_SYSTEM.md" ] && check_link "$REPO_DIR/APPEND_SYSTEM.md" "$AGENT_DIR/APPEND_SYSTEM.md"

# 2. Live -> repo: nothing under ~/.pi/agent/<kind>/ should be real or stray.
for kind in $KINDS; do
  live_dir="$AGENT_DIR/$kind"
  [ -d "$live_dir" ] || continue
  for dst in "$live_dir"/*; do
    [ -e "$dst" ] || [ -L "$dst" ] || continue # empty dir
    if [ ! -L "$dst" ]; then
      echo "real:     $dst is not a symlink (should live in this repo)"
      problems=$((problems + 1))
    elif [ ! -e "$dst" ]; then
      echo "broken:   $dst -> $(readlink "$dst")"
      problems=$((problems + 1))
    else
      case "$(readlink "$dst")" in
        "$REPO_DIR"/*) ;;
        *)
          echo "foreign:  $dst -> $(readlink "$dst") (outside this repo)"
          problems=$((problems + 1))
          ;;
      esac
    fi
  done
done

if [ "$problems" -eq 0 ]; then
  echo "ok: repo and $AGENT_DIR are fully in sync"
else
  echo "found $problems problem(s)"
  exit 1
fi
