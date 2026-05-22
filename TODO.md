# TODO / Ideas

Living list of things to build, polish, or explore for this repo. Move items to the README (under "Extensions") once they ship, or delete them once we've decided against them.

## Repo plumbing

- [ ] `scripts/link.sh` — idempotent script that walks `extensions/` and (re)creates the symlinks under `~/.pi/agent/extensions/`. Handy after a fresh clone or when adding several extensions at once.
- [ ] `scripts/doctor.sh` — sanity check that every file under `extensions/` has a matching symlink in `~/.pi/agent/extensions/` and vice versa (flag orphans on either side).
- [ ] Decide on a remote (GitHub? private?) and push.
- [ ] CI: run `tsc --noEmit` on push so type regressions are caught even though pi doesn't need a build.
- [ ] Pin `@earendil-works/pi-coding-agent` to the exact installed version in `package.json`, or auto-sync it from the globally installed one.

## Layout

- [ ] Revisit the flat layout once we have 3+ extensions or one of them grows beyond a single file → move to `extensions/<name>/index.ts` with per-extension READMEs.
- [ ] Consider sibling top-level folders for other pi customization surfaces (`skills/`, `themes/`, `prompt-templates/`) and a single `link.sh` that wires them all up. Read `docs/skills.md`, `docs/themes.md`, `docs/prompt-templates.md` before committing to a layout.

## Extension ideas

- [ ] **session-notes** — append a short, structured note (cwd, branch, summary) to a daily markdown log on `turn_end` or `session_end`.
- [ ] **cost-tracker** — surface running token/cost totals in the footer; persist per-day rollups.
- [ ] **git-dirty** — extend `folder-branch` with a marker (`*`, `+`, `?`) when the worktree is dirty / has staged / untracked files. Decide whether to fold into `folder-branch` or keep separate.
- [ ] **worktree-warning** — warn in the footer when cwd is a git worktree of a repo whose main checkout has uncommitted changes.
- [ ] **focus-timer** — pomodoro-style status entry, toggled via a slash command (needs the command/RPC API — see `docs/rpc.md`).
- [ ] **auto-stash** — on `session_start`, if the worktree is dirty, offer to stash with a session-tagged message; restore on `session_end`. Probably needs user confirmation UI.

## Things to explore (not yet ideas)

- [ ] Read `docs/extensions.md` end-to-end and list every hook/event we're not yet using.
- [ ] Read `docs/tui.md` to understand what's possible beyond `setStatus` (panels? modals? prompts?).
- [ ] Read `docs/rpc.md` and `docs/sdk.md` — can extensions register slash commands or expose RPC endpoints?
- [ ] Read `docs/prompt-templates.md` — overlap vs. extensions for "inject context at session start" use cases.
- [ ] Check whether extensions can ship their own settings (read from `~/.pi/agent/settings.json` or a sidecar file).
