# pi-extensions

Canonical home for my customizations to the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): extensions, skills, themes, and prompt templates.

pi loads each of these from a directory under `~/.pi/agent/`. This repo keeps the real source under version control; everything in `~/.pi/agent/{extensions,skills,themes,prompts}/` should be a symlink into the matching directory here.

## Repo layout

```
.
├── extensions/      # .ts extensions      → ~/.pi/agent/extensions/
│   └── status-bar.ts
├── skills/          # Agent Skills        → ~/.pi/agent/skills/
├── themes/          # .json TUI themes    → ~/.pi/agent/themes/
├── prompts/         # .md prompt templates → ~/.pi/agent/prompts/
├── scripts/         # link.sh / doctor.sh (planned)
├── package.json     # devDeps only: @earendil-works/pi-coding-agent for types
├── tsconfig.json    # editor-only; pi loads .ts directly, no build step
├── README.md
└── TODO.md
```

Each top-level directory has its own short README with format and linking specifics.

Flat layout inside each directory is fine while every entry is a single file. Promote an extension or skill to its own directory the moment it gains a second file or wants its own README.

## How things are wired up

Pi discovers each kind of customization by scanning a fixed directory under `~/.pi/agent/`. We keep those directories pointing into this repo via per-entry symlinks, so:

- editing a file in this repo edits what pi loads;
- `git status` here is the source of truth;
- nothing in `~/.pi/agent/{extensions,skills,themes,prompts}/` is "real" — every entry there should be a symlink into this repo.

Verify with `ls -la ~/.pi/agent/<kind>/`; every line should show `-> /Users/roberto/Dev/pi-extensions/<kind>/...`.

## Adding something new

See the per-directory README for the exact command, but the shape is always the same:

1. Create the file (or folder, for directory-form skills) under the matching top-level directory.
2. Symlink it into `~/.pi/agent/<kind>/` with the same basename.
3. Start a new pi session (or restart) to pick it up.
4. Commit.

A `scripts/link.sh` is planned (see [TODO.md](TODO.md)) to do step 2 for every entry at once.

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
 <folder> <branch> <dirty-dot> <context-bar>

 <model> • <effort>                                   $cost [(sub)] pct%/win
```

**Colors:**
- **folder** → `accent`
- **branch** → `success`
- **dirty-dot** → green clean / yellow staged-only / red unstaged-or-untracked; absent outside a git repo
- **context-bar** → 5-cell `█`/`░`, colored by pi's thresholds (dim ≤70, warning >70, error >90)
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
| `exit` | **Deferred.** Input passes through (`action: "continue"`) so the agent can still reply / run tools. `ctx.shutdown()` runs from `agent_end` once the whole loop wraps up. A `ctx.ui.notify(...)` confirms the exit is queued. |

`agent_end` is used (rather than `turn_end`) for the deferred case because a single user message can span multiple turns when tools are called; we want to exit only when the agent has fully finished. Only `source: "interactive"` inputs are considered, so an RPC or extension-sent message containing a trigger can't accidentally tear down the session.

## Reference

Pi's docs are installed alongside the npm package, at:

```
~/.asdf/installs/nodejs/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/
```

Most relevant: `extensions.md`, `skills.md`, `themes.md`, `prompt-templates.md`, plus `tui.md`, `rpc.md`, `sdk.md` for deeper APIs.
