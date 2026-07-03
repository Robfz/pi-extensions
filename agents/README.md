# agents/

Subagent definitions consumed by the `subagent` extension (see [`../extensions/subagent/`](../extensions/subagent/)).

- **Pi scans:** `~/.pi/agent/agents/*.md` (user scope, always loaded). The `subagent` tool also reads `.pi/agents/*.md` from the project tree when `agentScope: "both"` or `"project"`.
- **Format:** Markdown with YAML frontmatter. Required keys: `name`, `description`. Optional: `tools` (comma-separated list), `model`, `runner` (`pi` default, or `cursor` to run on Cursor CLI — see below).

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

Bundled agents (verbatim from the upstream `subagent` extension example):

| Agent | Purpose | Model | Tools |
|---|---|---|---|
| `scout` | Fast codebase recon, returns compressed context for handoff | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans from context | Sonnet | read, grep, find, ls |
| `worker` | General-purpose, full capabilities, isolated context | Sonnet | (all default) |
| `reviewer` | Code review (read-only bash for `git diff`/`log`/`show`) | Sonnet | read, grep, find, ls, bash |
| `cursor-worker` | Worker on Cursor CLI (`runner: cursor`) | Composer 2.5 Fast | (all cursor-agent tools) |

## Cursor runner

Agents with `runner: cursor` execute via `cursor-agent -p --output-format stream-json --force --trust` instead of a `pi` subprocess:

- `model` takes Cursor model slugs (`cursor-agent models`), e.g. `composer-2.5`, `composer-2.5-fast`, `gpt-5.3-codex`.
- The markdown body is embedded in the prompt inside `<agent-instructions>` tags (cursor-agent has no system-prompt flag).
- `tools:` frontmatter is ignored (no allowlist flag in cursor-agent). All runs are `--force` (writes allowed) — don't define read-only cursor agents expecting enforcement.
- Requires `cursor-agent` on PATH and auth (`cursor-agent login` or `CURSOR_API_KEY`).
- Token usage is read from the terminal `result` event (input/output/cache-read/cache-write); dollar cost and context size aren't reported by the Cursor CLI. Stats show tokens, turns, wall-clock duration, and model. Tool results are captured into the tool-call details.
- Agents with an unrecognized `runner:` value are skipped entirely (surfaces as "Unknown agent") rather than silently run on pi.

Reference: `examples/extensions/subagent/` in the locally installed `@earendil-works/pi-coding-agent` package.
