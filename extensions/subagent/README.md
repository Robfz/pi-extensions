# subagent extension

Vendored, near-verbatim copy of the upstream subagent example from `@earendil-works/pi-coding-agent` (`examples/extensions/subagent/`). Replaces the previous heavyweight [`pi-subagents`](https://github.com/nicobailon/pi-subagents) npm package (~70 source files) with the leaner reference implementation (two source files, ~1.1 kloc) so we own the surface area and can tweak it from here.

## What it does

Registers one tool, `subagent`, that delegates work to focused child agents. Three modes via params:

| Mode | Params | Behavior |
|---|---|---|
| Single | `{ agent, task }` | Spawn one child, return its final output |
| Parallel | `{ tasks: [{agent, task}, …] }` | Up to 8 children, 4 concurrent, 50 KB output cap each |
| Chain | `{ chain: [{agent, task}, …] }` | Sequential; `{previous}` placeholder receives prior step's output |

Each invocation spawns a fresh `pi --mode json -p --no-session` subprocess with the agent's system prompt and tool/model allowlist, streams its `message_end` / `tool_result_end` JSON events, and renders progress in the TUI (collapsed by default, Ctrl+O to expand). `AbortSignal` propagates as SIGTERM → SIGKILL.

## Agent definitions

See [`../../agents/`](../../agents/). Agents are markdown files with YAML frontmatter (`name`, `description`, `tools?`, `model?`).

- `~/.pi/agent/agents/*.md` — user scope (always loaded).
- `.pi/agents/*.md` — project scope. **Default is `agentScope: "user"`.** Project agents are opt-in via `agentScope: "both"` or `"project"`; when running interactively the tool prompts for confirmation the first time a project agent is invoked (unless `confirmProjectAgents: false`).

## Workflow prompt templates

The bundled prompts under [`../../prompts/`](../../prompts/) (`implement.md`, `scout-and-plan.md`, `implement-and-review.md`) are plain prompt templates that tell the parent agent to use the `subagent` tool with a specific `chain`. They're surfaced as slash commands (`/implement`, `/scout-and-plan`, `/implement-and-review`) by pi's normal prompt template loading.

## Files

- `index.ts` — tool registration, child-process orchestration, TUI rendering.
- `agents.ts` — filesystem discovery of `*.md` agent definitions (user + optional project scope).

## Departures from upstream

None yet — this is a verbatim vendor. Tweaks land as follow-up commits with a rationale in `CHANGELOG.md` / git history.

## Reference

- Upstream source: `~/.asdf/installs/nodejs/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (also at `packages/coding-agent/examples/extensions/subagent/` in [earendil-works/pi](https://github.com/earendil-works/pi)).
- Docs: `docs/extensions.md` (extension API), `docs/prompt-templates.md` (workflow prompts) in the installed pi package.
