# TODO / Ideas

Living list of things to build, polish, or explore for this repo. Move items to the README (under "Extensions") once they ship, or delete them once we've decided against them.

## Repo plumbing

- [ ] `scripts/link.sh` — idempotent script that walks `extensions/`, `skills/`, `themes/`, `prompts/` and (re)creates the symlinks under the matching `~/.pi/agent/<kind>/`. Handy after a fresh clone or when adding several entries at once.
- [ ] `scripts/doctor.sh` — sanity check that every entry in this repo has a matching symlink under `~/.pi/agent/`, and flag orphan symlinks (broken or pointing outside this repo).
- [ ] Decide on a remote (GitHub? private?) and push.
- [ ] CI: run `tsc --noEmit` on push so type regressions are caught even though pi doesn't need a build.
- [ ] Pin `@earendil-works/pi-coding-agent` to the exact installed version in `package.json`, or auto-sync it from the globally installed one.

## Layout

- [x] Sibling top-level folders for the other pi customization surfaces (`skills/`, `themes/`, `prompts/`).
- [ ] Revisit the flat layout inside `extensions/` once we have 3+ extensions or one grows beyond a single file → move to `extensions/<name>/index.ts` with per-extension READMEs.

## Behavior tweaks I want

Things about pi's out-of-the-box behavior I want to change. Each needs a quick spike to figure out the right mechanism (extension hook? setting? keybinding? prompt template?) before turning into a real task.

- [x] **`exit` actually exits pi.** Shipped as `extensions/exit-command.ts`: `input` hook flags bare-word `exit`/`quit`, `agent_end` hook calls `ctx.shutdown()`. Agent gets to respond first.
- [ ] **Customize the SYSTEM prompt.** Tune the system prompt to my preferences (tone, defaults, conventions I always want enforced). Figure out:
  - whether to do this via a prompt template (`prompts/`) selected per-session, an extension that injects/edits the system message at `session_start`, or settings;
  - what pi's default system prompt currently contains so I'm tweaking deltas rather than rewriting from scratch.
  - Refs: `docs/prompt-templates.md`, `docs/extensions.md` (look for session/prompt hooks), `docs/usage.md`.
- [ ] **Tree navigation keyboard overrides.** Rebind the TUI tree navigation (file tree / session tree / whichever component) to keys that match my muscle memory. Figure out:
  - which tree(s) pi actually exposes and which keys are bound today;
  - whether keybindings are user-configurable via settings or require a TUI extension.
  - Refs: `docs/keybindings.md`, `docs/tui.md`, `docs/settings.md`.

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
