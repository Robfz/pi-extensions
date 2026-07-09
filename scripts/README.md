# scripts/

Helper scripts for managing this repo. Nothing here is loaded by pi; these only operate on the symlinks under `~/.pi/agent/`.

- `apply-settings.sh` — deep-merge the curated `settings/settings.json` into the live `~/.pi/agent/settings.json`, preserving keys pi writes itself. Requires `jq`.
- `link.sh` — idempotently (re)create the per-entry symlinks under `~/.pi/agent/{extensions,agents,skills,themes,prompts}/` (plus `APPEND_SYSTEM.md`) for every entry in this repo. Safe to run after a fresh clone; never clobbers real (non-symlink) files.
- `doctor.sh` — verify every entry in this repo has a matching symlink under `~/.pi/agent/`, and flag real files, broken symlinks, and symlinks pointing outside this repo. Exits non-zero on problems.

All scripts honor `PI_AGENT_DIR` (default `~/.pi/agent`).

Keep scripts dependency-free (POSIX sh or bash) so a fresh clone is immediately usable.
