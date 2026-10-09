# ultraspawns/

Saved ultraspawn scripts for the `spawn` tool's ultraspawn mode (see [`../extensions/subagent/`](../extensions/subagent/)).

- **Pi scans:** `~/.pi/agent/ultraspawns/*.js` (user scope) and the nearest `.pi/ultraspawns/*.js` in the project tree (project scope: opt-in with `agentScope: "both"` or `"project"`, like project agents; wins a name clash). The `spawn` tool reads them; pi itself doesn't.
- **Format:** one `.js` file per ultraspawn; the file's stem is the ultraspawn name. The file is the *body* of an async function, the same form as an inline `spawn({script})`: top-level `await` and `return` work, and the returned plain data (usually a markdown string) is the tool result. Start with a `//` comment header: its first line (`<name>: <what it does>`) is the description listed in the `spawn` tool description, the rest documents the `args` the script reads.
- **API:** `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `applyPatch`, documented in the [`ultraspawn` skill](../skills/ultraspawn/SKILL.md). Scripts run in a separate worker thread (so a runaway script never blocks pi and abort kills it) with only these globals: no `require`, filesystem, network, or timers. That is not a security boundary; a script can reach Node APIs through host-realm function constructors. An approved script is trusted code that runs with your user's permissions.
- **Invocation:** `spawn({ultraspawn: "<name>", args: {…}})`, usually through a thin prompt template in [`../prompts/`](../prompts/) (e.g. `/ultrareview`). Approval is the trust gate. Interactive sessions ask on every run (Run / View script / Auto-approve for this project and run / Cancel) unless the project is auto-approved. Without a UI (print/json mode), a run proceeds only in an auto-approved project or for a user-scope ultraspawn with `agentScope: "user"`; project ultraspawns, inline scripts, and any scope that includes project agents are refused. Details: [`../extensions/subagent/README.md`](../extensions/subagent/README.md#ultraspawn-mode).
- **Linking:** per-file symlink from `~/.pi/agent/ultraspawns/<name>.js` → this directory's file (`scripts/link.sh` does it).
- **Build step:** none.

```sh
$EDITOR ultraspawns/<name>.js
ln -s "$PWD/ultraspawns/<name>.js" ~/.pi/agent/ultraspawns/<name>.js
```

| Ultraspawn | Args | What it does | Prompt |
|---|---|---|---|
| `review` | `base?` (default: repo default branch) | Verified multi-angle review of the working tree against `git merge-base <base> HEAD`: 6 `reviewer` angles → `judge` dedupe → `adversarial-reviewer` per finding → `verifier` per surviving finding in an isolated worktree → markdown report sorted by severity and confidence | `/ultrareview [base-branch]` |
