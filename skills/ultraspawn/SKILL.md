---
name: ultraspawn
description: Write and run multi-agent orchestration scripts for the spawn tool's ultraspawn mode (agent/parallel/pipeline/phase/log/args/applyPatch). Use before calling spawn({script}), when the user asks for a custom multi-agent ultraspawn (fan-out reviews, verify or fix-until-pass loops, research fan-out), or for a verified code review.
---

# Ultraspawn scripts

Ultraspawn mode runs a JS script that orchestrates many child agents and returns one result. You see only that result, not the children's transcripts. Use it when a job needs more agents or more control flow than the plain `spawn` modes (single, parallel up to 8, chain) give, for example dozens of agents, a branch on structured output, or loops. For a handful of independent tasks, plain `spawn` is simpler.

- Saved: `spawn({ultraspawn: "review", args: {base: "main"}})`. Saved ultraspawns live in `~/.pi/agent/ultraspawns/<name>.js` (user) and `.pi/ultraspawns/<name>.js` (project; opt-in with `agentScope: "both"` like project agents, then wins a name clash).
- Inline: `spawn({script: "<function body>", args: {…}})`.

Approval is the trust gate: an approved script is trusted code that runs with the user's permissions.

- **With a UI:** the user approves each run in a dialog (Run / View script / Auto-approve for this project and run / Cancel). When `agentScope` includes project agents and the project has any, the dialog lists them and the user agents they override. Auto-approval persists per project in `~/.pi/agent/ultraspawn-approvals.json`; an auto-approved project runs without a dialog (just a notification).
- **Without a UI (print/json mode):** a run goes ahead only if the project is auto-approved, or if it is a user-scope saved ultraspawn called with `agentScope: "user"` (the default). Everything else is refused: inline scripts, project ultraspawns, and any run whose `agentScope` includes project agents. To run those headless, auto-approve the project from an interactive session first.

## Script form

The script is the **body of an async function**: top-level `await` and `return` work. `return` plain data (a string, usually markdown, or JSON-serializable objects and arrays). That value is the tool result, uncapped. It passes through JSON: `Date`s become ISO strings and `undefined` fields are dropped; `Map`, `Set`, `BigInt`, `NaN`/`Infinity`, functions and cycles fail the run. A thrown error fails the run.

Environment: the script runs in a separate worker thread, so a runaway loop never blocks pi and abort kills it immediately. Only the globals below plus standard JS built-ins (`JSON`, `Math`, `Promise`, …) are provided: no `require`/`import`, `fs`, network, `process`, `setTimeout`, or `fetch`. `console.log` is an alias for `log`. Children do all I/O. This is not a security boundary (a script can reach Node APIs through host-realm function constructors); the approval step is what decides whether a script runs.

## API

```ts
agent(prompt: string, opts?: {
  agent?: string;          // agent name, default "general"
  schema?: object;         // JSON Schema for the final answer → result.data
  timeout?: number;        // ms; one budget for all attempts, from when the call gets a concurrency slot (includes worktree setup)
  isolation?: "worktree";  // run in a throwaway copy; changes come back as result.patch
  label?: string;          // shown in progress rows and logs
}): Promise<AgentResult>   // never rejects for child failures; check ok

parallel(items, fn?)       // fn given: Promise.all(items.map(fn)); else items are functions or promises
pipeline(stages, input)    // sequential: each stage (prev, i) => value | Promise; returns the last value
phase(name, fn)            // groups agents under a progress heading; returns await fn(); may nest; run phases one after another
log(...values)             // progress log line (objects JSON-stringified)
args                       // frozen copy of spawn's args ({} when omitted)
applyPatch(patch: string)  // → {ok: true} | {ok: false, error}
```

```ts
interface AgentResult {
  ok: boolean;
  agent: string; label?: string; phase?: string;
  output: string;                               // final assistant text (followups block stripped)
  data?: unknown;                               // validated JSON when schema was given and ok
  error?: string;
  reason?: "error" | "timeout" | "aborted" | "schema" | "unknown-agent" | "isolation";
  followUps: { task: string; agent: string }[]; // extra work the child asked for
  patch?: string;                               // isolation: "worktree" only
  attempts: number;                             // 1 + schema retries used
  usage: { input; output; cacheRead; cacheWrite; cost; contextTokens; turns };
  model?: string;
  durationMs: number;
}
```

`reason` on failure: `error` (child crashed or errored), `timeout` (exceeded `timeout`), `aborted` (user pressed Esc), `schema` (no valid JSON after 3 retries; `error` lists the validation errors), `unknown-agent` (no such agent, or it isn't a pi-runner agent), `isolation` (worktree creation failed, or not a git repo).

## Rules

- **Agents:** only pi-runner agents from `agents/` (the `spawn` tool description lists them). Cursor agents (`cursor-worker`, `cross-reviewer`) are rejected. Model and thinking level come from the agent file; there are no per-call overrides. The default `general` agent has pi's own system prompt, so put all instructions in the prompt.
- **No recursion:** every child runs with `spawn`/`subagent` excluded. A child that wants more work done ends its answer with a `followups` block, which surfaces as `result.followUps`. Queuing it is your script's job (see example 1). Ignored follow-ups are lost.
- **Schema:** plain JSON Schema (`type`, `properties`, `required`, `enum`, `items`, `minimum`, `pattern`, …). The child is told to answer with one fenced json block. Invalid output is retried up to 3 times with the validation errors fed back. Always set `required`, and use `enum` for verdicts and severities.
- **Isolation:** `isolation: "worktree"` gives the child a temporary git worktree of HEAD plus the user's uncommitted and untracked changes. Gitignored state (`node_modules`, `.env`, build output) is missing, and the child installs what it needs. After the child finishes, its changes are captured as `result.patch` (binary-safe `git diff`) and the worktree is deleted. Without isolation, children share the user's checkout. Use isolation for anything that writes files or runs tests in parallel.
- **applyPatch:** applies a patch to the user's checkout, all or nothing against `git apply --check`: on conflict nothing changes and you get `{ok: false, error}`. `applyPatch` calls are serialized with each other, but the operation is not transactional against other writers: a non-isolated agent (or the user) editing the checkout at the same time can still race it. Don't run non-isolated writers while applying patches. Apply patches in a deliberate order and handle conflicts.
- **Phases:** `phase()` calls may nest. Run sibling phases one after another: when phases overlap in time, an `agent()` call is attributed to the most recently started phase that is still active.
- **Timeouts:** the `timeout` clock starts when the call gets one of the 16 concurrency slots, not when you call `agent()`, so queued time doesn't count. It does include worktree setup for `isolation: "worktree"`; a setup already in progress (normally seconds, capped at 2 minutes) completes before the timeout or an abort takes effect.
- **Cross-realm values:** `args` and `agent()` results come from another realm. Use `Array.isArray(x)`, not `x instanceof Array` (same for `Object`, `Error`, …), which is false for them.
- **Limits:** 16 agents run concurrently (extra calls queue), and there is no cap on the total. Every agent's cost is added to the session's subagent spend. Prompts aren't capped, so pass file lists and refs and let children read the code themselves.
- Don't wrap `agent()` in try/catch for child failures. Branch on `ok`. Report failed agents in your result rather than dropping them silently.

## Examples

**1. Fan-out with a follow-up queue**

```js
const files = args.files ?? [];
const findings = [];
const queue = files.map((f) => ({ agent: "reviewer", task: `Review ${f} for correctness bugs.` }));
const schema = { type: "object", required: ["issues"], properties: { issues: { type: "array", items: {
  type: "object", required: ["file", "line", "issue"],
  properties: { file: { type: "string" }, line: { type: "integer" }, issue: { type: "string" } } } } } };
let rounds = 0;
while (queue.length && rounds++ < 3) {
  const batch = queue.splice(0);
  const results = await phase(`round ${rounds}`, () =>
    parallel(batch, (job) => agent(job.task, { agent: job.agent, schema, label: job.task.slice(0, 40) })));
  for (const r of results) {
    if (r.ok) findings.push(...r.data.issues); else log(`failed ${r.label}: ${r.reason}`);
    queue.push(...r.followUps);        // children's requests for more work
  }
}
return findings;
```

**2. Isolated fixes, applied in order**

```js
const fixes = await parallel(args.tasks, (task, i) =>
  agent(`${task}\nRun the relevant tests; finish only when they pass.`, { agent: "worker", isolation: "worktree", timeout: 20 * 60_000, label: `fix ${i + 1}` }));
const report = [];
for (const r of fixes) {
  if (!r.ok || !r.patch) { report.push(`- ${r.label}: ${r.ok ? "no changes" : r.reason}`); continue; }
  const applied = await applyPatch(r.patch);
  report.push(`- ${r.label}: ${applied.ok ? "applied" : `conflict: ${applied.error}`}`);
}
return report.join("\n");
```

**3. Structured verdicts**

```js
const verdict = { type: "object", required: ["verdict", "reason"], properties: {
  verdict: { type: "string", enum: ["stands", "refuted", "uncertain"] }, reason: { type: "string" } } };
const claims = args.claims;
const checks = await parallel(claims, (c) => agent(`Try to refute: ${c}`, { agent: "adversarial-reviewer", schema: verdict, label: c.slice(0, 30) }));
return claims.map((c, i) => `${checks[i].ok ? checks[i].data.verdict : `failed (${checks[i].reason})`}: ${c}`).join("\n");
```

## Saved ultraspawns

Save reusable scripts as `.pi/ultraspawns/<name>.js` (project) or in this repo's `ultraspawns/` (linked to `~/.pi/agent/ultraspawns/`). The file has the same function-body form as an inline script, with a leading `//` comment whose first line describes the ultraspawn (`<name>: <what it does>`, shown in the `spawn` tool description) and whose rest documents `args`. Run with `spawn({ultraspawn: "<name>", args})`; project ultraspawns also need `agentScope: "both"`. A saved run sends only the name over the tool call, so you never re-emit the script. `review` is the canned verified review (`/ultrareview [base-branch]`).
