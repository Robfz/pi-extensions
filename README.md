# pi-extensions

Canonical home for my customizations to the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): extensions, skills, themes, prompt templates, and settings.

pi loads each of these from a directory under `~/.pi/agent/`. This repo keeps the real source under version control; everything in `~/.pi/agent/{extensions,skills,themes,prompts}/` should be a symlink into the matching directory here. Settings are handled differently — see [`settings/`](settings/README.md).

## Repo layout

```
.
├── extensions/        # .ts extensions       → ~/.pi/agent/extensions/      (symlinked)
│   ├── status-bar.ts
│   ├── exit-command.ts
│   ├── label.ts
│   └── subagent/         # directory-form (index.ts + agents.ts + README)
├── agents/            # subagent defs (.md)  → ~/.pi/agent/agents/          (symlinked)
├── skills/            # Agent Skills         → ~/.pi/agent/skills/          (symlinked)
├── themes/            # .json TUI themes     → ~/.pi/agent/themes/          (symlinked)
├── prompts/           # .md prompt templates → ~/.pi/agent/prompts/         (symlinked)
├── settings/          # curated settings.json → ~/.pi/agent/settings.json   (merged via script)
├── APPEND_SYSTEM.md   # appended to system prompt → ~/.pi/agent/APPEND_SYSTEM.md (symlinked)
├── scripts/           # apply-settings.sh; link.sh / doctor.sh (planned)
├── package.json       # devDeps only: @earendil-works/pi-coding-agent for types
├── tsconfig.json      # editor-only; pi loads .ts directly, no build step
├── README.md
└── TODO.md
```

Each top-level directory has its own short README with format and linking specifics.

`APPEND_SYSTEM.md` is a single file at the repo root rather than a subdirectory because upstream itself reads a single file at `~/.pi/agent/APPEND_SYSTEM.md` — keeping it flat preserves the 1:1 path mirror. Its contents are appended to pi's default system prompt on every session (the default prompt is kept; this is *additive*, not a replacement — for that, use `SYSTEM.md` instead, which we deliberately don't). See `docs/usage.md` “System Prompt Files” in the locally installed pi package.

`settings/` is the odd one out: pi writes back to `~/.pi/agent/settings.json` (e.g. `lastChangelogVersion` bumps after upgrades), so symlinking would dirty `git status` constantly. Instead, the repo holds only the keys I deliberately set, and `scripts/apply-settings.sh` deep-merges them into the live file, preserving pi's own writes.

Flat layout inside each directory is fine while every entry is a single file. Promote an extension or skill to its own directory the moment it gains a second file or wants its own README.

## How things are wired up

Pi discovers each kind of customization by scanning a fixed directory under `~/.pi/agent/`. We keep those directories pointing into this repo via per-entry symlinks, so:

- editing a file in this repo edits what pi loads;
- `git status` here is the source of truth;
- nothing in `~/.pi/agent/{extensions,skills,themes,prompts}/` is "real" — every entry there should be a symlink into this repo.

Verify with `ls -la ~/.pi/agent/<kind>/`; every line should show `-> /Users/roberto/Dev/pi-extensions/<kind>/...`.

## Adding something new

For extensions / skills / themes / prompts, see the per-directory README for the exact command, but the shape is always the same:

1. Create the file (or folder, for directory-form skills) under the matching top-level directory.
2. Symlink it into `~/.pi/agent/<kind>/` with the same basename.
3. Start a new pi session (or restart) to pick it up.
4. Commit.

A `scripts/link.sh` is planned (see [TODO.md](TODO.md)) to do step 2 for every entry at once.

For settings: add the key to `settings/settings.json`, run `scripts/apply-settings.sh`, commit. See [`settings/README.md`](settings/README.md).

## Editing

Just edit the file in this repo. The symlink means pi sees the change on next session start. No build, no install step.

If you want type-checking and autocomplete in your editor for extensions:

```sh
npm install   # pulls @earendil-works/pi-coding-agent + typescript as devDeps
```

## Removing

```sh
rm ~/.pi/agent/<kind>/<name>.<ext>   # the symlink
git rm <kind>/<name>.<ext>
```

## Conventions

Extension-specific:

- **One default export** — a function `(pi: ExtensionAPI) => void` that registers hooks.
- **Top-of-file doc comment** describing what the extension does and which hooks it uses.
- **Types from `@earendil-works/pi-coding-agent`** — never re-declare `ExtensionAPI` / `ExtensionContext`.
- **Defensive I/O** — wrap shell calls and filesystem reads in try/catch with short timeouts; an extension that throws shouldn't break the session.
- **Stable status keys** — when using `ctx.ui.setStatus`, pick a unique string and reuse it across updates.

Repo-wide:

- **Match upstream names** — repo directory names mirror the `~/.pi/agent/` paths (`extensions`, `skills`, `themes`, `prompts`) so the symlink mapping is 1:1.
- **Per-directory README** — each top-level directory documents its own format and linking command. Keep the root README about cross-cutting concerns.

## Extensions

### `status-bar`

Replaces pi's default footer (via `ctx.ui.setFooter`) with a three-line layout (blank spacer between content lines) and 1-column left/right padding:

```
 <folder> <branch> <dirty-dot> <context-bar>                       <session-name>

 <model> • <effort>                                   $cost [(sub)] pct%/win
```

**Colors:**
- **folder** → `accent`
- **branch** → `success`
- **dirty-dot** → green clean / yellow staged-only / red unstaged-or-untracked; absent outside a git repo
- **context-bar** → 5-cell `█`/`░`, colored by pi's thresholds (dim ≤70, warning >70, error >90)
- **session-name** (right-anchored on line 1) → `accent` when set; falls back to `unnamed` in `dim` when no name is configured. Dropped entirely only when line 1 has no room for it.
- **model** → `accent` (with leading `Claude ` stripped: `Claude Opus 4.7` → `Opus 4.7`)
- **effort** → pi's matching `thinking{Level}` theme key, so `high` glows the way pi glows it elsewhere
- **right-side stats** → reuses the context-percentage color so a high-context session goes warning/error across the whole stats segment

**Stats** are reduced to just `$cost [(sub)] pct%/win`. Tokens, cache R/W, and the `(auto)` indicator are intentionally dropped (the last because the extension API does not expose auto-compact state).

Refreshes the git dirty cache on `session_start` and `turn_end`; reacts to branch changes via `footerData.onBranchChange`.

### `exit-command`

Two flavors of exit (all triggers are case-insensitive and must be the entire message after trimming):

| Trigger | Behavior |
|---|---|
| `.exit`, `.q` | **Immediate.** Input is consumed (`action: "handled"`), never reaches the agent. `ctx.shutdown()` runs right away. |
| `exit` | **Deferred.** Input passes through (`action: "continue"`) so the agent can still reply / run tools. Shutdown is *armed* at `before_agent_start` for the agent loop whose `prompt` is `exit`, and *fired* from that loop's `agent_end`. A `ctx.ui.notify(...)` confirms the exit is queued. |

`agent_end` is used (rather than `turn_end`) for the deferred case because a single user message can span multiple turns when tools are called; we want to exit only when the agent has fully finished. Arming at `before_agent_start` (rather than at `input` time) avoids a race: an `exit` typed while a *previous* agent loop is still streaming would otherwise see that earlier loop's `agent_end` first and shut pi down before the queued `exit` ever reached the agent. Only `source: "interactive"` inputs are considered for the gate, so an RPC or extension-sent message containing the literal string `exit` can't accidentally tear down the session.

### `subagent`

Directory-form extension under [`extensions/subagent/`](extensions/subagent/). Near-verbatim vendor of the upstream subagent example from `@earendil-works/pi-coding-agent` (`examples/extensions/subagent/`), replacing the previous [`pi-subagents`](https://github.com/nicobailon/pi-subagents) npm package (~70 source files) with the leaner reference (`index.ts` + `agents.ts`, ~1.1 kloc).

Registers one tool, `subagent`, with three modes: single (`{agent, task}`), parallel (`{tasks: […]}`, up to 8 / 4 concurrent / 50 KB per task), and chain (`{chain: […]}` with `{previous}` placeholder). Each call spawns a fresh `pi --mode json -p --no-session` subprocess per agent and streams JSON events back for collapsed/expanded TUI rendering.

Agent definitions live in [`agents/`](agents/) (user scope) and `.pi/agents/` per-project (opt-in via `agentScope: "both"`, with confirmation prompt). Workflow prompt templates that drive the tool's chain mode are in [`prompts/`](prompts/) (`implement`, `scout-and-plan`, `implement-and-review`).

Dropped from the previous implementation, on purpose: async/background runs, slash commands like `/run` and `/subagents-doctor`, agent CRUD via `action`, forked-context spawning, worktree isolation, skills injection, control/attention tracking, and the `oracle`/`researcher`/`context-builder`/`delegate` builtins. If any of those turn out to be missed, layer them back in piecewise rather than reinstalling the heavyweight package.

See [`extensions/subagent/README.md`](extensions/subagent/README.md) for full details.

### `label`

Label the last assistant message from outside `/tree`. Labels persist in the session JSONL and show up under the tree view's "labeled only" filter.

| Command | Behavior |
|---|---|
| `/label` | Labels the last assistant message as `label-<timestamp>` |
| `/label <name>` | Labels the last assistant message as `<name>` |
| `/unlabel` | Removes the label from the most recently labeled entry |

Adapted from the upstream `examples/extensions/bookmark.ts`, renamed to match pi's own "label" vocabulary.

## Settings

Tracked in [`settings/settings.json`](settings/settings.json), per-key rationale in [`settings/README.md`](settings/README.md). Highlights:

- `defaultThinkingLevel: "high"` — generous default thinking budget.
- `treeFilterMode: "no-tools"` — hide tool calls in `/tree` by default.
- `npmCommand: [...]` — force asdf-managed Node so pi's package commands resolve the right `npm`.

Apply with `scripts/apply-settings.sh` (idempotent, preserves pi's own writes like `lastChangelogVersion`).

## Reference

Pi's docs are installed alongside the npm package, at:

```
~/.asdf/installs/nodejs/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/
```

Most relevant: `extensions.md`, `skills.md`, `themes.md`, `prompt-templates.md`, plus `tui.md`, `rpc.md`, `sdk.md` for deeper APIs.
