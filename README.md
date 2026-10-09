# pi-extensions

Canonical home for my customizations to the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): extensions, skills, themes, prompt templates, and settings.

pi loads each of these from a directory under `~/.pi/agent/`. This repo keeps the real source under version control; everything in `~/.pi/agent/{extensions,agents,skills,themes,prompts,workflows}/` should be a symlink into the matching directory here. Settings are handled differently — see [`settings/`](settings/README.md).

## Repo layout

```
.
├── extensions/        # .ts extensions       → ~/.pi/agent/extensions/      (symlinked)
│   ├── status-bar.ts
│   ├── exit-command.ts
│   ├── label.ts
│   └── subagent/         # directory-form (index.ts + runner/render/types/agents + README)
├── agents/            # subagent defs (.md)  → ~/.pi/agent/agents/          (symlinked)
├── skills/            # Agent Skills         → ~/.pi/agent/skills/          (symlinked)
├── themes/            # .json TUI themes     → ~/.pi/agent/themes/          (symlinked)
├── prompts/           # .md prompt templates → ~/.pi/agent/prompts/         (symlinked)
├── workflows/         # .js workflow scripts → ~/.pi/agent/workflows/       (symlinked)
├── settings/          # curated settings.json → ~/.pi/agent/settings.json   (merged via script)
├── APPEND_SYSTEM.md   # appended to system prompt → ~/.pi/agent/APPEND_SYSTEM.md (symlinked)
├── scripts/           # apply-settings.sh, link.sh, doctor.sh
├── .pi/skills/        # project-local skills for working on this repo (not symlinked)
├── package.json       # devDeps only: @earendil-works/pi-* + typebox, for extension types
├── package-lock.json
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
- nothing in `~/.pi/agent/{extensions,agents,skills,themes,prompts,workflows}/` is "real" — every entry there should be a symlink into this repo.

Verify with `ls -la ~/.pi/agent/<kind>/`; every line should show `-> <path-to-this-repo>/<kind>/...`.

One exception: Herdr, if installed, writes its pi state bridge to `~/.pi/agent/extensions/herdr-agent-state.ts` as a real file and updates it itself. It is not tracked here, and `scripts/doctor.sh` skips it.

## Adding something new

For extensions / skills / themes / prompts / workflows, see the per-directory README for the exact command, but the shape is always the same:

1. Create the file (or folder, for directory-form skills) under the matching top-level directory.
2. Symlink it into `~/.pi/agent/<kind>/` with the same basename.
3. Start a new pi session (or restart) to pick it up.
4. Commit.

`scripts/link.sh` does step 2 for every entry at once (idempotent — safe after a fresh clone), and `scripts/doctor.sh` verifies the wiring.

After pulling or cloning, the project-local `refresh-install` skill (`/skill:refresh-install` from inside this repo) runs the full sync: prunes stale symlinks, relinks, applies settings, removes pi packages the repo no longer lists, and installs devDeps.

For settings: add the key to `settings/settings.json`, run `scripts/apply-settings.sh`, commit. See [`settings/README.md`](settings/README.md).

## Editing

Just edit the file in this repo. The symlink means pi sees the change on next session start. No build, no install step.

If you want type-checking and autocomplete in your editor for extensions:

```sh
npm install   # pulls the @earendil-works/pi-* packages, typebox, and typescript as devDeps
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

- **Match upstream names** — repo directory names mirror the `~/.pi/agent/` paths (`extensions`, `skills`, `themes`, `prompts`, and `workflows`, which the `spawn` tool reads) so the symlink mapping is 1:1.
- **Per-directory README** — each top-level directory documents its own format and linking command. Keep the root README about cross-cutting concerns.

## Extensions

### `status-bar`

Replaces pi's default footer (via `ctx.ui.setFooter`) with a three-line layout (blank spacer between content lines) and 1-column left/right padding:

```
 <folder> <branch> <dirty-dot> <context-bar>                       <session-name>

 <model> • <effort>                      $cost [(sub)] [(sa $cost)] pct%/win
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

**Stats** are reduced to just `$cost [(sub)] [(sa $cost)] pct%/win`, both figures rounded up to cents. `$cost` matches pi's footer (all branches of the session file). `(sa …)` is the spend published by the `subagent` extension's `spawn` tool, shown once any subagent call exists in the session (cursor-runner calls report no cost, so they contribute $0.00). Tokens, cache R/W, and the `(auto)` indicator are intentionally dropped (the last because the extension API does not expose auto-compact state).

Refreshes the git dirty cache on `session_start` and `turn_end`; reacts to branch changes via `footerData.onBranchChange` and to subagent spend via the `subagent:spend` channel on `pi.events`.

### `exit-command`

Two flavors of exit (all triggers are case-insensitive and must be the entire message after trimming):

| Trigger | Behavior |
|---|---|
| `.exit`, `.q` | **Immediate.** Input is consumed (`action: "handled"`), never reaches the agent. `ctx.shutdown()` runs right away. |
| `exit` | **Deferred.** Input passes through (`action: "continue"`) so the agent can still reply / run tools. Shutdown is *armed* at `before_agent_start` for the agent loop whose `prompt` is `exit`, and *fired* from that loop's `agent_end`. A `ctx.ui.notify(...)` confirms the exit is queued. |

`agent_end` is used (rather than `turn_end`) for the deferred case because a single user message can span multiple turns when tools are called; we want to exit only when the agent has fully finished. Arming at `before_agent_start` (rather than at `input` time) avoids a race: an `exit` typed while a *previous* agent loop is still streaming would otherwise see that earlier loop's `agent_end` first and shut pi down before the queued `exit` ever reached the agent. Only `source: "interactive"` inputs are considered for the gate, so an RPC or extension-sent message containing the literal string `exit` can't accidentally tear down the session.

### `subagent`

Directory-form extension under [`extensions/subagent/`](extensions/subagent/), vendored from the upstream example (`examples/extensions/subagent/` in `@earendil-works/pi-coding-agent`) with local additions: a Cursor CLI runner, an `excludedTools` tool denylist, a `thinking` level per agent, a tool description that lists the available agents, and workflow mode.

Registers one tool, `spawn` (not `subagent`, which the `pi-subagents` package claims), with four modes: single (`{agent, task}`), parallel (`{tasks: […]}`, up to 8 / 4 concurrent / 50 KB output per task), chain (`{chain: […]}` with `{previous}` placeholder), and workflow (`{workflow}` or `{script}`, below). Each agent runs in a fresh subprocess chosen by its `runner:` frontmatter. Every runner's events are normalized into the same message shape, so streaming, chaining, and TUI rendering (collapsed by default, Ctrl+O to expand) are shared:

| Runner | Subprocess | Notes |
|---|---|---|
| `pi` (default) | `pi --mode json -p --no-session` | System prompt via `--append-system-prompt`; `tools:` / `excludedTools:` / `model:` / `thinking:` frontmatter map to pi's tool allowlist (`--tools`), denylist (`--exclude-tools`), model, and `--thinking`. |
| `cursor` | `cursor-agent -p --output-format stream-json --force --trust` | `model:` takes Cursor slugs; `tools:` is ignored and `excludedTools:` is rejected (agent skipped); `mode: plan` or `ask` gives CLI-enforced read-only runs. Needs `cursor-agent` on PATH and auth. |

Agent definitions live in [`agents/`](agents/) (user scope, always loaded): `scout`, `web-scout`, `figma-scout`, `planner`, `worker`, `reviewer`, plus the workflow agents `general`, `judge`, `adversarial-reviewer`, `verifier` on pi; `cursor-worker`, `cross-reviewer` on cursor — see the table in [`agents/README.md`](agents/README.md). Project-scope agents in `.pi/agents/` are opt-in via `agentScope: "project"` or `"both"`; interactive sessions ask for confirmation the first time one is invoked (disable with `confirmProjectAgents: false`). User-scope agents discovered at startup are listed in the tool description so the model knows what's available; new agent files need a session restart to be advertised.

Workflow prompt templates that drive chain mode live in [`prompts/`](prompts/) and surface as `/implement`, `/scout-and-plan`, `/implement-and-review`.

Workflow mode runs a JS orchestration script: `spawn({workflow: "<name>", args})` for a saved script, or `spawn({script, args})` for an inline one. The script runs in a sandboxed `node:vm` worker thread and drives pi-runner child agents through `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, and `applyPatch`. Children can't spawn agents themselves; they return follow-up requests that the script queues. `agent()` supports JSON Schema output with retries, timeouts, and `isolation: "worktree"` (a throwaway git worktree whose changes come back as a patch). The parent model sees only the script's result. Progress renders inside the tool call, and every child's cost counts toward the `(sa $…)` spend. Each run asks for approval (Run / View script / Auto-approve for this project / Cancel), and auto-approvals persist per project in `~/.pi/agent/workflow-approvals.json`. Saved scripts live in [`workflows/`](workflows/README.md) (linked to `~/.pi/agent/workflows/`) or a project's `.pi/workflows/` (opt-in via `agentScope`, like project agents). `review` is a verified multi-angle review, run via `/review [base-branch]`. The model learns the API from the [`workflow` skill](skills/workflow/SKILL.md).

Full runner details: [`extensions/subagent/README.md`](extensions/subagent/README.md) and [`agents/README.md`](agents/README.md).

### `label`

Label the last assistant message from outside `/tree`. Labels persist in the session JSONL and show up under the tree view's "labeled only" filter.

| Command | Behavior |
|---|---|
| `/label` | Labels the last assistant message as `label-<timestamp>` |
| `/label <name>` | Labels the last assistant message as `<name>` |
| `/unlabel` | Removes the label from the most recently labeled entry |

Adapted from the upstream `examples/extensions/bookmark.ts`, renamed to match pi's own "label" vocabulary.

## Settings

Tracked in [`settings/settings.json`](settings/settings.json), per-key rationale in [`settings/README.md`](settings/README.md):

| Key | Value |
|---|---|
| `defaultProvider` | `anthropic` |
| `defaultModel` | `claude-opus-5-5` |
| `defaultThinkingLevel` | `high` |
| `theme` | `dark` |
| `editorPaddingX` | `1` |
| `treeFilterMode` | `no-tools` — hide tool calls in `/tree` |
| `packages` | `npm:pi-web-access` — pi installs missing ones on startup |

Apply with `scripts/apply-settings.sh` (idempotent, preserves pi's own writes like `lastChangelogVersion`). Note that the merge replaces `packages` wholesale, so this list is authoritative — a package added ad hoc via `pi install` is dropped on the next apply unless added here.

MCP servers come from pi's built-in MCP support and are configured per machine in `~/.pi/agent/mcp.json`, which this repo doesn't track, since which servers are relevant or reachable differs between machines. Pi doesn't expand variables in `url`, so a service with several sites (e.g. Datadog) needs one entry per site; to keep a project on one site, use "Disable in this project" in `/mcp` on the others. OAuth tokens stay per machine in `~/.pi/agent/mcp-auth.json`; sign in to each server once via `/mcp`.

## Reference

Pi's docs are installed alongside the npm package:

```sh
ls "$(npm root -g)/@earendil-works/pi-coding-agent/docs/"
```

Most relevant: `extensions.md`, `skills.md`, `themes.md`, `prompt-templates.md`, plus `tui.md`, `rpc.md`, `sdk.md` for deeper APIs.
