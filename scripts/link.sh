#!/usr/bin/env bash
#
# link.sh
#
# Idempotently (re)create the per-entry symlinks under ~/.pi/agent/ for every
# entry in this repo:
#
#   <repo>/<kind>/<entry>  ->  ~/.pi/agent/<kind>/<entry>
#   <repo>/<file>           -> ~/.pi/agent/<file>   (APPEND_SYSTEM.md)
#
# Kinds: extensions, agents, skills, themes, prompts.
# README.md files and dotfiles at the top of each kind dir are skipped.
#
# Existing correct symlinks are left alone. Symlinks pointing elsewhere are
# replaced. Real (non-symlink) files/dirs are never clobbered — they're
# reported so you can resolve them by hand.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
KINDS="extensions agents skills themes prompts"
TOP_FILES="APPEND_SYSTEM.md"

linked=0 kept=0 skipped=0

link_entry() { # $1=source (repo), $2=target (live)
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    if [ "$(readlink "$dst")" = "$src" ]; then
      kept=$((kept + 1))
      return
    fi
    ln -sfn "$src" "$dst"
    echo "relinked: $dst -> $src"
    linked=$((linked + 1))
  elif [ -e "$dst" ]; then
    echo "warning: $dst exists and is not a symlink; skipping (resolve by hand)" >&2
    skipped=$((skipped + 1))
  else
    ln -s "$src" "$dst"
    echo "linked:   $dst -> $src"
    linked=$((linked + 1))
  fi
}

for kind in $KINDS; do
  src_dir="$REPO_DIR/$kind"
  [ -d "$src_dir" ] || continue
  mkdir -p "$AGENT_DIR/$kind"
  for src in "$src_dir"/*; do
    [ -e "$src" ] || continue # empty dir
    name="$(basename "$src")"
    [ "$name" = "README.md" ] && continue
    link_entry "$src" "$AGENT_DIR/$kind/$name"
  done
done

mkdir -p "$AGENT_DIR"
for name in $TOP_FILES; do
  [ -f "$REPO_DIR/$name" ] && link_entry "$REPO_DIR/$name" "$AGENT_DIR/$name"
done

echo "done: $linked linked, $kept already correct, $skipped skipped"
[ "$skipped" -eq 0 ]
