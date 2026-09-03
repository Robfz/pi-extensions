# agents/

Subagent definitions consumed by the `subagent` extension (see [`../extensions/subagent/`](../extensions/subagent/)).

- **Pi scans:** `~/.pi/agent/agents/*.md` (user scope, always loaded). The `subagent` tool also reads `.pi/agents/*.md` from the project tree when `agentScope: "both"` or `"project"`.
- **Format:** Markdown with YAML frontmatter. Required keys: `name`, `description`. Optional: `tools` (comma-separated list), `model`, `runner` (`pi` default, `cursor` for Cursor CLI, or `claude` for Claude Code — see below), `mode` (cursor runner only: `plan` or `ask` for CLI-enforced read-only).

  ```markdown
  ---
  name: my-agent
  description: What this agent does
  tools: read, grep, find, ls
  model: claude-haiku-4-5
  ---

  System prompt body.
  ```

- **Linking:** per-file symlink from `~/.pi/agent/agents/<name>.md` → this directory's file.
- **Build step:** none.

```sh
$EDITOR agents/<name>.md
ln -s "$PWD/agents/<name>.md" ~/.pi/agent/agents/<name>.md
```

Directory is named `agents/` (not `agent-defs/` or `subagents/`) to match the upstream path 1:1 so the symlink mapping is trivial.

Bundled agents (from the upstream `subagent` extension example; descriptions locally sharpened for routing):

| Agent | Purpose | Model | Tools |
|---|---|---|---|
| `scout` | Fast codebase recon, returns compressed context for handoff | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans from context | Sonnet | read, grep, find, ls |
| `worker` | General-purpose, full capabilities; default for work requiring judgment | Sonnet | (all default) |
| `reviewer` | Code review (read-only bash for `git diff`/`log`/`show`) | Sonnet | read, grep, find, ls, bash |
| `cursor-worker` | Cheap/fast worker on Cursor CLI (`runner: cursor`); prefer for mechanical or bulk edits | Composer 2.5 Fast | (all cursor-agent tools) |

Local additions:

| Agent | Purpose | Model | Tools |
|---|---|---|---|
| `figma-explorer` | Explore a Figma node URL via the Figma remote MCP, report implementation-ready specs (`runner: claude`) | Sonnet | `mcp__figma` (allowed) |
| `cross-reviewer` | Cross-model code review from an OpenAI model — independent eyes vs. Anthropic/Cursor authors (`runner: cursor`, `mode: plan`) | GPT-5.6 Terra Medium | read-only (plan mode) |

## Cursor runner

Agents with `runner: cursor` execute via `cursor-agent -p --output-format stream-json --force --trust` instead of a `pi` subprocess:

- `model` takes Cursor model slugs (`cursor-agent models`), e.g. `composer-2.5`, `composer-2.5-fast`, `gpt-5.3-codex`.
- The markdown body is embedded in the prompt inside `<agent-instructions>` tags (cursor-agent has no system-prompt flag).
- `tools:` frontmatter is ignored (no allowlist flag in cursor-agent). By default runs are `--force` (writes allowed). For read-only agents, set `mode: plan` (or `ask`) — it maps to `cursor-agent --mode` and blocks writes at the CLI level even with `--force` (edit attempts become inert plan proposals; the run still terminates cleanly). `mode:` on non-cursor runners is rejected (agent skipped), since nothing would enforce it there.
- Requires `cursor-agent` on PATH and auth (`cursor-agent login` or `CURSOR_API_KEY`).
- Token usage is read from the terminal `result` event (input/output/cache-read/cache-write); dollar cost and context size aren't reported by the Cursor CLI. Stats show tokens, turns, wall-clock duration, and model. Tool results are captured into the tool-call details.
- Agents with an unrecognized `runner:` value are skipped entirely (surfaces as "Unknown agent") rather than silently run on pi.

## Claude runner

Agents with `runner: claude` execute via `claude -p --output-format stream-json --verbose` (Claude Code headless):

- `model` takes Claude Code model names or aliases (`sonnet`, `opus`, `haiku`, or full model IDs).
- The markdown body is passed via `--append-system-prompt` (native flag, no temp file). The task is fed via stdin so variadic flags can't swallow it.
- `tools:` frontmatter maps to `--allowedTools` — **auto-approval, not restriction**. In `-p` mode, tools that aren't allowed are silently denied (so writes are effectively blocked unless allowlisted). MCP tools use full names, e.g. `mcp__plugin_figma_figma` (bare server name allows all its tools).
- The run uses the user's normal Claude Code config: MCP servers and their auth all apply. This is the whole point of `figma-explorer` — the Figma remote MCP (`https://mcp.figma.com/mcp`) only accepts allowlisted clients (Claude Code, Cursor, VS Code, …) and pi isn't on the list, so we hop through Claude Code's authenticated `figma` server.
- **Don't rely on plugin-bundled MCP servers** (`mcp__plugin_<plugin>_<server>__<tool>`): Claude Code has a long-standing bug where plugin MCP servers connect but their tools are never injected into sessions (anthropics/claude-code#49019 — the connect loop shows "disposing orphaned connect (slot removed mid-flight)" in `~/Library/Caches/claude-cli-nodejs/*/mcp-logs-*`). User/project-scope servers work. `figma-explorer` therefore uses a user-scope server: `claude mcp add --transport http --scope user figma https://mcp.figma.com/mcp`, authenticated once via `/mcp` in an interactive session (OAuth tokens are keyed per server identity, so the plugin's token is not reused).
- MCP tools are deferred behind `ToolSearch`; agents must load them first (e.g. `ToolSearch("select:mcp__figma__get_design_context")`) before calling.
- Requires `claude` on PATH and auth (`claude` login or `ANTHROPIC_API_KEY`).
- Usage/cost come from the terminal `result` event (tokens, `total_cost_usd`, `num_turns`, wall-clock). A run that exits 0 without a `result` event is treated as an error.

Reference: `examples/extensions/subagent/` in the locally installed `@earendil-works/pi-coding-agent` package.
