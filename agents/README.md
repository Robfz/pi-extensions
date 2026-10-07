# agents/

Subagent definitions consumed by the `subagent` extension's `spawn` tool (see [`../extensions/subagent/`](../extensions/subagent/)).

- **Pi scans:** `~/.pi/agent/agents/*.md` (user scope, always loaded). The `spawn` tool also reads `.pi/agents/*.md` from the project tree when `agentScope: "both"` or `"project"`.
- **Format:** Markdown with YAML frontmatter. Required keys: `name`, `description`. Optional: `tools` (comma-separated allowlist → `pi --tools`), `excludedTools` (comma-separated denylist → `pi --exclude-tools`, pi runner only; the agent gets pi's default tools plus extension/MCP tools, minus the listed exact names; applied after `tools:` if both are set), `model`, `runner` (`pi` default, or `cursor` for Cursor CLI — see below), `mode` (cursor runner only: `plan` or `ask` for CLI-enforced read-only).

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
| `scout` | Fast codebase recon, returns compressed context for handoff; MCP access (e.g. Linear) via `tool_search`; read-only is prompt-level, not enforced | Sonnet 5.5 | read, bash, `tool_search` (+ MCP) |
| `planner` | Implementation plans from context | Fable 5.1 | read, grep, find, ls |
| `worker` | General-purpose, full capabilities; default for work requiring judgment | Opus 5.5 | (all default) |
| `reviewer` | Code review (read-only bash for `git diff`/`log`/`show`) | Opus 5.5 | read, grep, find, ls, bash |
| `cursor-worker` | Cheap/fast worker on Cursor CLI (`runner: cursor`); prefer for mechanical or bulk edits | Composer 2.5 Fast | (all cursor-agent tools) |

Local additions:

| Agent | Purpose | Model | Tools |
|---|---|---|---|
| `web-scout` | Web research recon, returns compressed, cited findings; is instructed to call `web_enable` first; MCP access via `tool_search`; read-only is prompt-level, not enforced | Sonnet 5.5 | read, bash, `tool_search` (+ MCP), `web_enable` (+ web tools) |
| `figma-scout` | Explore a Figma node URL via the Figma remote MCP (`mcp__figma__*`, loaded with `tool_search`), report implementation-ready specs; read-only and Figma-only are prompt-level, not enforced | Opus 5.5 | read, bash, `tool_search` (+ MCP) |
| `cross-reviewer` | Cross-model code review from an OpenAI model — independent eyes vs. Anthropic/Cursor authors (`runner: cursor`, `mode: plan`) | GPT-5.6 Terra Medium | read-only (plan mode) |

## Cursor runner

Agents with `runner: cursor` execute via `cursor-agent -p --output-format stream-json --force --trust` instead of a `pi` subprocess:

- `model` takes Cursor model slugs (`cursor-agent models`), e.g. `composer-2.5`, `composer-2.5-fast`, `gpt-5.3-codex`.
- The markdown body is embedded in the prompt inside `<agent-instructions>` tags (cursor-agent has no system-prompt flag).
- `tools:` frontmatter is ignored and `excludedTools:` is rejected (agent skipped), since cursor-agent has no allowlist/denylist flag. By default runs are `--force` (writes allowed). For read-only agents, set `mode: plan` (or `ask`) — it maps to `cursor-agent --mode` and blocks writes at the CLI level even with `--force` (edit attempts become inert plan proposals; the run still terminates cleanly). `mode:` on non-cursor runners is rejected (agent skipped), since nothing would enforce it there.
- Requires `cursor-agent` on PATH and auth (`cursor-agent login` or `CURSOR_API_KEY`).
- Token usage is read from the terminal `result` event (input/output/cache-read/cache-write); dollar cost and context size aren't reported by the Cursor CLI. Stats show tokens, turns, wall-clock duration, and model. Tool results are captured into the tool-call details.
- Agents with an unrecognized `runner:` value are skipped entirely (surfaces as "Unknown agent") rather than silently run on pi.

Reference: `examples/extensions/subagent/` in the locally installed `@earendil-works/pi-coding-agent` package.
