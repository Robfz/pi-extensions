# agents/

Subagent definitions consumed by the `subagent` extension (see [`../extensions/subagent/`](../extensions/subagent/)).

- **Pi scans:** `~/.pi/agent/agents/*.md` (user scope, always loaded). The `subagent` tool also reads `.pi/agents/*.md` from the project tree when `agentScope: "both"` or `"project"`.
- **Format:** Markdown with YAML frontmatter. Required keys: `name`, `description`. Optional: `tools` (comma-separated list), `model`.

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

Reference: `examples/extensions/subagent/` in the locally installed `@earendil-works/pi-coding-agent` package.
