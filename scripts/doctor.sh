#!/usr/bin/env bash
#
# doctor.sh
#
# Verify the symlink wiring between this repo and ~/.pi/agent/:
#
#   1. Every repo entry (extensions/agents/skills/themes/prompts/ultraspawns, plus
#      APPEND_SYSTEM.md) has a symlink under ~/.pi/agent/ pointing at it.
#   2. Every entry inside ~/.pi/agent/<kind>/ is a symlink into this repo —
#      flags real files, broken symlinks, and symlinks pointing elsewhere,
#      except integrations explicitly managed by another application.
#   3. No symlink directly under ~/.pi/agent/ points into this repo at a path
#      that no longer exists (e.g. a file the repo stopped tracking).
#
# Exits 0 when everything checks out, 1 otherwise. Fix problems with
# scripts/link.sh (or by hand for real-file conflicts).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
KINDS="extensions agents skills themes prompts ultraspawns"
TOP_FILES="APPEND_SYSTEM.md"

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
for name in $TOP_FILES; do
  [ -f "$REPO_DIR/$name" ] && check_link "$REPO_DIR/$name" "$AGENT_DIR/$name"
done

# 2. Live -> repo: nothing under ~/.pi/agent/<kind>/ should be real or stray.
for kind in $KINDS; do
  live_dir="$AGENT_DIR/$kind"
  [ -d "$live_dir" ] || continue
  for dst in "$live_dir"/*; do
    [ -e "$dst" ] || [ -L "$dst" ] || continue # empty dir
    # Herdr installs and updates its Pi state bridge as a real file.
    if [ "$kind/$(basename "$dst")" = "extensions/herdr-agent-state.ts" ] &&
       [ -f "$dst" ] && [ ! -L "$dst" ]; then
      continue
    fi
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

# 3. Top level: dangling symlinks into this repo left by removed or untracked files.
for dst in "$AGENT_DIR"/* "$AGENT_DIR"/.[!.]*; do
  [ -L "$dst" ] && [ ! -e "$dst" ] || continue
  case "$(readlink "$dst")" in
    "$REPO_DIR"/*)
      echo "broken:   $dst -> $(readlink "$dst") (target gone from this repo: rm the link; recreate it as a real file if pi still needs it)"
      problems=$((problems + 1))
      ;;
  esac
done

if [ "$problems" -eq 0 ]; then
  echo "ok: repo and $AGENT_DIR are fully in sync"
else
  echo "found $problems problem(s)"
  exit 1
fi
