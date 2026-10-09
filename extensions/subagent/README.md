# subagent extension

Derived from the upstream subagent example in `@earendil-works/pi-coding-agent` (`examples/extensions/subagent/`), split into several source files and extended locally (see Departures).

## What it does

Registers one tool, `spawn`, that delegates work to focused child agents. Four modes via params:

| Mode | Params | Behavior |
|---|---|---|
| Single | `{ agent, task }` | Spawn one child, return its final output |
| Parallel | `{ tasks: [{agent, task}, …] }` | Up to 8 children, 4 concurrent, 50 KB output cap each |
| Chain | `{ chain: [{agent, task}, …] }` | Sequential; `{previous}` placeholder receives prior step's output |
| Workflow | `{ workflow, args? }` or `{ script, args? }` | Runs a saved or inline orchestration script (see Workflow mode) |

Each invocation spawns a fresh subprocess per the agent's `runner`:

- **`pi` (default):** `pi --mode json -p --no-session` with the agent's system prompt (temp file via `--append-system-prompt`), model (`model:` → `--model`), thinking level (`thinking:` → `--thinking`), tool allowlist (`tools:` → `--tools`), and tool denylist (`excludedTools:` → `--exclude-tools`); parses `message_end` / `tool_result_end` JSON events.
- **`cursor`:** `cursor-agent -p --output-format stream-json --force --trust` with the system prompt embedded in the prompt (`<agent-instructions>` tags); parses cursor NDJSON events (`system/init` → model, `assistant` → text turns, `tool_call` started/completed → tool call + tool result messages, `result` → stop reason / fallback text) into the same `Message[]` shape so streaming, chaining, and rendering are shared. `tools:` frontmatter is ignored and `excludedTools:` is rejected (agent skipped), since cursor-agent has no allowlist/denylist flag; `mode:` frontmatter (`plan` or `ask`) maps to `--mode` for CLI-enforced read-only execution; token usage comes from the terminal `result` event (no dollar cost or context size), and a cursor run that exits 0 without a terminal `result` event is treated as an error.

All runners stream progress into the TUI (collapsed by default, Ctrl+O to expand). `AbortSignal` propagates as SIGTERM → SIGKILL.

The extension publishes cumulative subagent spend (finished calls across all branches of the session file plus in-flight calls) as `{ cost, hasRun }` on `pi.events` channel `subagent:spend`, re-emitted on every `session_start` and on each subagent tool start/update/end. The [`status-bar`](../status-bar.ts) extension renders it. Cursor runs and aborted calls contribute $0.

## Agent definitions

See [`../../agents/`](../../agents/). Agents are markdown files with YAML frontmatter (`name`, `description`, `tools?`, `excludedTools?` — pi only: denylist passed as `--exclude-tools`, `model?`, `thinking?` — pi only: `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` passed as `--thinking`, `runner?`, `mode?` — cursor only: `plan`/`ask` for CLI-enforced read-only). An invalid value, or a pi-only key on a cursor agent, skips the agent so it surfaces as "Unknown agent".

- `~/.pi/agent/agents/*.md` — user scope (always loaded).
- `.pi/agents/*.md` — project scope. **Default is `agentScope: "user"`.** Project agents are opt-in via `agentScope: "both"` or `"project"`; when running interactively the tool prompts for confirmation the first time a project agent is invoked (unless `confirmProjectAgents: false`).

## Workflow prompt templates

The bundled prompts under [`../../prompts/`](../../prompts/) (`implement.md`, `scout-and-plan.md`, `implement-and-review.md`) are plain prompt templates that tell the parent agent to use the `spawn` tool with a specific `chain`. They're surfaced as slash commands (`/implement`, `/scout-and-plan`, `/implement-and-review`) by pi's normal prompt template loading.

## Workflow mode

`spawn({ script, args? })` runs an inline JS orchestration script and `spawn({ workflow: "<name>", args? })` a saved one: the body of an async function that receives `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `applyPatch` (plus `console.*` aliased to `log`) and must return plain data. The script runs in a bare `node:vm` context inside a worker thread, so a runaway loop never blocks pi and abort terminates it immediately.

- `agent(prompt, { agent?, label?, schema?, timeout?, isolation? })` runs one pi agent (default `general`; cursor agents are rejected) and resolves to `{ ok, output, data?, patch?, error?, reason?, followUps, attempts, usage, … }` — child failures are values (`reason`: `error`, `timeout`, `aborted`, `schema`, `unknown-agent`, `isolation`), never throws. At most 16 agents run at once.
  - `schema` (JSON Schema object): the child is told to answer with a ```` ```json ```` block; the last such block (or the whole output) is parsed and validated with TypeBox `Value.Check`. An invalid answer is retried up to 3 times with the previous output and the validation errors in the prompt — each attempt is a new child process. Valid → `data`; still invalid → `reason: "schema"`.
  - `timeout` (ms): one budget for all attempts of the call; expiry aborts the child → `reason: "timeout"`.
  - `isolation: "worktree"`: the child runs in a temporary git worktree under `$TMPDIR/pi-workflow-<runId>/` holding HEAD plus the checkout's uncommitted and untracked (not ignored) changes. Its changes come back as `patch` (`git diff --binary`, incl. new and binary files) and the worktree is deleted as soon as the agent finishes; the run directory is swept when the run ends, also on abort or failure. Gitignored state (`node_modules`, `.env`, build output) is not copied.
- `applyPatch(patch)` applies a patch to the user's checkout all-or-nothing (`git apply --check`, then `git apply`) and resolves to `{ ok: true }` or `{ ok: false, error }` with the checkout untouched. An empty patch is `{ ok: true }`. Calls are serialized.
- Every child gets `--exclude-tools spawn,subagent` merged with its own `excludedTools`, so children never spawn agents. A child asks for more work by ending its reply with a ```` ```followups ```` JSON block of `{task, agent}`; it comes back in `followUps` for the script to queue.
- Each child process is a `details.results[]` entry (messages dropped), so spend tracking covers workflows live and after the run.
- The final result is returned uncapped.
- Saved workflows: `<name>.js` files with the same function-body form as `script`, starting with a `//` comment header whose first line describes the workflow and whose rest documents `args`. User scope: `~/.pi/agent/workflows/*.js` (symlinks followed; see [`../../workflows/`](../../workflows/)). Project scope: the nearest `.pi/workflows/*.js` at or above cwd, opt-in through `agentScope` exactly like project agents (`"both"` adds them and they win a name clash, `"project"` uses only them). Names match `^[a-z0-9][a-z0-9._-]*$` (case-insensitive). An unknown name is an error listing the available workflows. User-scope workflows discovered at startup are listed in the tool description.
- Approval: in TUI/RPC sessions every run asks Run / View script / Auto-approve for this project / Cancel; the dialog title shows the file path of a saved workflow. Auto-approvals are stored per git toplevel in `~/.pi/agent/workflow-approvals.json`. Without a UI (print/json mode), saved workflows and auto-approved projects run, and inline scripts are refused.

## Files

- `index.ts` — tool registration and params, spend tracking, workflow approval, single/parallel/chain/workflow dispatch.
- `runner.ts` — child-process runner (`runSingleAgent`, `buildPiArgs`), pi/cursor event parsing, concurrency helper. No TUI imports.
- `render.ts` — `renderCall` / `renderResult` (incl. workflow progress) and formatting helpers.
- `workflow.ts` — workflow runtime host (`runWorkflow`): worker lifecycle, concurrency, `agent()` dispatch (schema retries, timeouts, isolation), `applyPatch`, progress, follow-up parsing.
- `schema.ts` — JSON extraction and TypeBox validation of agent output, schema/retry prompt text.
- `worktree.ts` — git worktree create/patch/remove/sweep and `applyPatch` on the checkout (git via `execFile`, hooks disabled).
- `workflow-worker-source.ts` — worker thread source (plain JS string) that runs the script in `node:vm`.
- `saved-workflows.ts` — discovery and name resolution of saved workflow scripts (user + optional project scope).
- `approvals.ts` — per-project workflow auto-approval file.
- `types.ts` — shared types (`SingleResult`, `SubagentDetails`, `SubagentSpend`), constants, pure result helpers.
- `agents.ts` — filesystem discovery of `*.md` agent definitions (user + optional project scope).
- `tests/` — `npm test` (node:test, fake runner + real git in temp dirs; needs Node ≥ 22.18 for TypeScript type stripping) and `npm run smoke` (real `pi` children, costs a few cents).

## Departures from upstream

- **Cursor runner** (`agents.ts`, `runner.ts`): agents can declare `runner: cursor` in frontmatter to execute on Cursor's `cursor-agent` CLI (headless mode, Composer 2.5 et al.) instead of a `pi` subprocess. See [`../../agents/README.md`](../../agents/README.md) for frontmatter semantics.
- **Tool denylist** (`agents.ts`, `runner.ts`): pi-runner agents can declare `excludedTools:` (comma-separated string or YAML list) to pass `--exclude-tools`, keeping every other tool including extension/MCP tools.
- **Thinking level** (`agents.ts`, `runner.ts`): pi-runner agents can declare `thinking:` to pass `--thinking`.
- **Workflow mode** (`index.ts`, `workflow.ts`, `saved-workflows.ts`, …): saved and inline orchestration scripts, described above.
- **Spend event** (`index.ts`): publishes cumulative subagent cost as `{ cost, hasRun }` on `pi.events` channel `subagent:spend` (payload type `SubagentSpend`).
- **Tool name** (`index.ts`): the tool is `spawn` instead of upstream's `subagent`, so it can load next to the [`pi-subagents`](https://github.com/nicobailon/pi-subagents) package, which registers `subagent` (pi refuses duplicate tool names). Agents that deny delegation list both names in `excludedTools`.
- **Dynamic tool description** (`index.ts`): user-scope agents and saved workflows discovered at registration are listed (name + description) in the `spawn` tool description, so the model knows what's available without a failed probe call. New files need a session restart to be advertised (invocation itself always uses fresh discovery).

## Reference

- Upstream source: `$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (also at `packages/coding-agent/examples/extensions/subagent/` in [earendil-works/pi](https://github.com/earendil-works/pi)).
- Docs: `docs/extensions.md` (extension API), `docs/prompt-templates.md` (workflow prompts) in the installed pi package.
