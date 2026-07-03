# subagent extension

Vendored, near-verbatim copy of the upstream subagent example from `@earendil-works/pi-coding-agent` (`examples/extensions/subagent/`). Replaces the previous heavyweight [`pi-subagents`](https://github.com/nicobailon/pi-subagents) npm package (~70 source files) with the leaner reference implementation (two source files, ~1.1 kloc) so we own the surface area and can tweak it from here.

## What it does

Registers one tool, `subagent`, that delegates work to focused child agents. Three modes via params:

| Mode | Params | Behavior |
|---|---|---|
| Single | `{ agent, task }` | Spawn one child, return its final output |
| Parallel | `{ tasks: [{agent, task}, …] }` | Up to 8 children, 4 concurrent, 50 KB output cap each |
| Chain | `{ chain: [{agent, task}, …] }` | Sequential; `{previous}` placeholder receives prior step's output |

Each invocation spawns a fresh subprocess per the agent's `runner`:

- **`pi` (default):** `pi --mode json -p --no-session` with the agent's system prompt (temp file via `--append-system-prompt`) and tool/model allowlist; parses `message_end` / `tool_result_end` JSON events.
- **`cursor`:** `cursor-agent -p --output-format stream-json --force --trust` with the system prompt embedded in the prompt (`<agent-instructions>` tags); parses cursor NDJSON events (`system/init` → model, `assistant` → text turns, `tool_call` started/completed → tool call + tool result messages, `result` → stop reason / fallback text) into the same `Message[]` shape so streaming, chaining, and rendering are shared. `tools:` frontmatter is ignored (cursor-agent has no allowlist flag); token usage comes from the terminal `result` event (no dollar cost or context size), and a cursor run that exits 0 without a terminal `result` event is treated as an error.

Both stream progress into the TUI (collapsed by default, Ctrl+O to expand). `AbortSignal` propagates as SIGTERM → SIGKILL.

## Agent definitions

See [`../../agents/`](../../agents/). Agents are markdown files with YAML frontmatter (`name`, `description`, `tools?`, `model?`, `runner?`).

- `~/.pi/agent/agents/*.md` — user scope (always loaded).
- `.pi/agents/*.md` — project scope. **Default is `agentScope: "user"`.** Project agents are opt-in via `agentScope: "both"` or `"project"`; when running interactively the tool prompts for confirmation the first time a project agent is invoked (unless `confirmProjectAgents: false`).

## Workflow prompt templates

The bundled prompts under [`../../prompts/`](../../prompts/) (`implement.md`, `scout-and-plan.md`, `implement-and-review.md`) are plain prompt templates that tell the parent agent to use the `subagent` tool with a specific `chain`. They're surfaced as slash commands (`/implement`, `/scout-and-plan`, `/implement-and-review`) by pi's normal prompt template loading.

## Files

- `index.ts` — tool registration, child-process orchestration, TUI rendering.
- `agents.ts` — filesystem discovery of `*.md` agent definitions (user + optional project scope).

## Departures from upstream

- **Cursor runner** (`agents.ts`, `index.ts`): agents can declare `runner: cursor` in frontmatter to execute on Cursor's `cursor-agent` CLI (headless mode, Composer 2.5 et al.) instead of a `pi` subprocess. See [`../../agents/README.md`](../../agents/README.md) for frontmatter semantics.

## Reference

- Upstream source: `~/.asdf/installs/nodejs/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (also at `packages/coding-agent/examples/extensions/subagent/` in [earendil-works/pi](https://github.com/earendil-works/pi)).
- Docs: `docs/extensions.md` (extension API), `docs/prompt-templates.md` (workflow prompts) in the installed pi package.
