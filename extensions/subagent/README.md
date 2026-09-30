# subagent extension

Vendored, near-verbatim copy of the upstream subagent example from `@earendil-works/pi-coding-agent` (`examples/extensions/subagent/`). Two source files (~1.1 kloc), small enough that we own the surface area and can tweak it here.

## What it does

Registers one tool, `subagent`, that delegates work to focused child agents. Three modes via params:

| Mode | Params | Behavior |
|---|---|---|
| Single | `{ agent, task }` | Spawn one child, return its final output |
| Parallel | `{ tasks: [{agent, task}, …] }` | Up to 8 children, 4 concurrent, 50 KB output cap each |
| Chain | `{ chain: [{agent, task}, …] }` | Sequential; `{previous}` placeholder receives prior step's output |

Each invocation spawns a fresh subprocess per the agent's `runner`:

- **`pi` (default):** `pi --mode json -p --no-session` with the agent's system prompt (temp file via `--append-system-prompt`), model (`model:` → `--model`), tool allowlist (`tools:` → `--tools`), and tool denylist (`excludedTools:` → `--exclude-tools`); parses `message_end` / `tool_result_end` JSON events.
- **`cursor`:** `cursor-agent -p --output-format stream-json --force --trust` with the system prompt embedded in the prompt (`<agent-instructions>` tags); parses cursor NDJSON events (`system/init` → model, `assistant` → text turns, `tool_call` started/completed → tool call + tool result messages, `result` → stop reason / fallback text) into the same `Message[]` shape so streaming, chaining, and rendering are shared. `tools:` frontmatter is ignored and `excludedTools:` is rejected (agent skipped), since cursor-agent has no allowlist/denylist flag; `mode:` frontmatter (`plan` or `ask`) maps to `--mode` for CLI-enforced read-only execution; token usage comes from the terminal `result` event (no dollar cost or context size), and a cursor run that exits 0 without a terminal `result` event is treated as an error.

All runners stream progress into the TUI (collapsed by default, Ctrl+O to expand). `AbortSignal` propagates as SIGTERM → SIGKILL.

The extension publishes cumulative subagent spend (finished calls across all branches of the session file plus in-flight calls) as `{ cost, hasRun }` on `pi.events` channel `subagent:spend`, re-emitted on every `session_start` and on each subagent tool start/update/end. The [`status-bar`](../status-bar.ts) extension renders it. Cursor runs and aborted calls contribute $0.

## Agent definitions

See [`../../agents/`](../../agents/). Agents are markdown files with YAML frontmatter (`name`, `description`, `tools?`, `excludedTools?` — pi only: denylist passed as `--exclude-tools`, `model?`, `runner?`, `mode?` — cursor only: `plan`/`ask` for CLI-enforced read-only).

- `~/.pi/agent/agents/*.md` — user scope (always loaded).
- `.pi/agents/*.md` — project scope. **Default is `agentScope: "user"`.** Project agents are opt-in via `agentScope: "both"` or `"project"`; when running interactively the tool prompts for confirmation the first time a project agent is invoked (unless `confirmProjectAgents: false`).

## Workflow prompt templates

The bundled prompts under [`../../prompts/`](../../prompts/) (`implement.md`, `scout-and-plan.md`, `implement-and-review.md`) are plain prompt templates that tell the parent agent to use the `subagent` tool with a specific `chain`. They're surfaced as slash commands (`/implement`, `/scout-and-plan`, `/implement-and-review`) by pi's normal prompt template loading.

## Files

- `index.ts` — tool registration, child-process orchestration, TUI rendering.
- `agents.ts` — filesystem discovery of `*.md` agent definitions (user + optional project scope).

## Departures from upstream

- **Cursor runner** (`agents.ts`, `index.ts`): agents can declare `runner: cursor` in frontmatter to execute on Cursor's `cursor-agent` CLI (headless mode, Composer 2.5 et al.) instead of a `pi` subprocess. See [`../../agents/README.md`](../../agents/README.md) for frontmatter semantics.
- **Tool denylist** (`agents.ts`, `index.ts`): pi-runner agents can declare `excludedTools:` (comma-separated string or YAML list) to pass `--exclude-tools`, keeping every other tool including extension/MCP tools.
- **Spend event** (`index.ts`): publishes cumulative subagent cost as `{ cost, hasRun }` on `pi.events` channel `subagent:spend` (payload type `SubagentSpend`).
- **Dynamic tool description** (`index.ts`): user-scope agents discovered at registration are listed (name + description) in the `subagent` tool description, so the model knows what's available without a failed probe call. New agent files need a session restart to be advertised (invocation itself always uses fresh discovery).

## Reference

- Upstream source: `$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (also at `packages/coding-agent/examples/extensions/subagent/` in [earendil-works/pi](https://github.com/earendil-works/pi)).
- Docs: `docs/extensions.md` (extension API), `docs/prompt-templates.md` (workflow prompts) in the installed pi package.
