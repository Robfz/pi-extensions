# workflows/

Saved workflow scripts for the `spawn` tool's workflow mode (see [`../extensions/subagent/`](../extensions/subagent/)).

- **Pi scans:** `~/.pi/agent/workflows/*.js` (user scope) and the nearest `.pi/workflows/*.js` in the project tree (project scope: opt-in with `agentScope: "both"` or `"project"`, like project agents; wins a name clash). The `spawn` tool reads them; pi itself doesn't.
- **Format:** one `.js` file per workflow; the file's stem is the workflow name. The file is the *body* of an async function, the same form as an inline `spawn({script})`: top-level `await` and `return` work, and the returned plain data (usually a markdown string) is the tool result. Start with a `//` comment header: its first line (`<name>: <what it does>`) is the description listed in the `spawn` tool description, the rest documents the `args` the script reads.
- **API:** `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `applyPatch`, documented in the [`workflow` skill](../skills/workflow/SKILL.md). Scripts run in a separate worker thread (so a runaway script never blocks pi and abort kills it) with only these globals: no `require`, filesystem, network, or timers. That is not a security boundary; a script can reach Node APIs through host-realm function constructors. An approved script is trusted code that runs with your user's permissions.
- **Invocation:** `spawn({workflow: "<name>", args: {…}})`, usually through a thin prompt template in [`../prompts/`](../prompts/) (e.g. `/review`). Approval is the trust gate. Interactive sessions ask on every run (Run / View script / Auto-approve for this project and run / Cancel) unless the project is auto-approved. Without a UI (print/json mode), a run proceeds only in an auto-approved project or for a user-scope workflow with `agentScope: "user"`; project workflows, inline scripts, and any scope that includes project agents are refused. Details: [`../extensions/subagent/README.md`](../extensions/subagent/README.md#workflow-mode).
- **Linking:** per-file symlink from `~/.pi/agent/workflows/<name>.js` → this directory's file (`scripts/link.sh` does it).
- **Build step:** none.

```sh
$EDITOR workflows/<name>.js
ln -s "$PWD/workflows/<name>.js" ~/.pi/agent/workflows/<name>.js
```

| Workflow | Args | What it does | Prompt |
|---|---|---|---|
| `review` | `base?` (default: repo default branch) | Verified multi-angle review of the working tree against `git merge-base <base> HEAD`: 6 `reviewer` angles → `judge` dedupe → `adversarial-reviewer` per finding → `verifier` per surviving finding in an isolated worktree → markdown report sorted by severity and confidence | `/review [base-branch]` |
