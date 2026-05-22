# scripts/

Helper scripts for managing this repo. Nothing here is loaded by pi; these only operate on the symlinks under `~/.pi/agent/`.

Planned (see [TODO.md](../TODO.md)):

- `link.sh` — idempotently (re)create the symlinks under `~/.pi/agent/{extensions,skills,themes,prompts}/` for every entry in this repo. Safe to run after a fresh clone.
- `doctor.sh` — verify every entry in this repo has a matching symlink under `~/.pi/agent/`, and flag orphan symlinks pointing nowhere (or pointing outside this repo).

Keep scripts dependency-free (POSIX sh or bash) so a fresh clone is immediately usable.
