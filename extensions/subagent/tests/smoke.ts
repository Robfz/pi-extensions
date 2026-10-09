/**
 * Manual smoke test of workflow mode with real pi children (costs a few cents; not part of `npm test`).
 * Run: npm run smoke. Needs `pi` on PATH with Anthropic credentials.
 * Covers: schema call, parallel of 2, log, a timeout that does not fire, one isolated agent + applyPatch.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents.ts";
import { runSingleAgent } from "../runner.ts";
import { subagentCost } from "../types.ts";
import { formatWorkflowResult, runWorkflow } from "../workflow.ts";
import { createIsolatedWorktree } from "../worktree.ts";

const MODEL = process.env.SMOKE_MODEL ?? "claude-haiku-4-5";

const agent: AgentConfig = {
	name: "smoke",
	description: "smoke test agent",
	runner: "pi",
	model: MODEL,
	excludedTools: ["spawn", "subagent"],
	systemPrompt: "Answer tersely. Do exactly what the task says and nothing more.",
	source: "user",
	filePath: "<memory>",
};

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.name", "smoke");
git("config", "user.email", "smoke@localhost");
git("config", "commit.gpgSign", "false");
fs.writeFileSync(path.join(repo, "README.md"), "smoke repo\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const script = String.raw`
const s = await phase("schema", () =>
	agent("What is 6 times 7? Respond with the JSON object {\"n\": <answer>}.", {
		agent: "smoke",
		schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
		timeout: 180000,
	}),
);
log("schema", s.ok, s.attempts, s.data);

const [a, b] = await phase("parallel", () =>
	parallel([
		() => agent("Reply with exactly the word alpha.", { agent: "smoke", label: "a" }),
		() => agent("Reply with exactly the word beta.", { agent: "smoke", label: "b" }),
	]),
);
log("parallel", a.ok && a.output, b.ok && b.output);

const w = await phase("isolated", () =>
	agent("Use the write tool to create a file named SMOKE.txt in the current directory containing exactly the text: hello. Then reply done.", {
		agent: "smoke",
		isolation: "worktree",
		timeout: 240000,
	}),
);
log("isolated", w.ok, w.reason ?? "", (w.patch ?? "").length, "patch bytes");
const applied = w.patch ? await applyPatch(w.patch) : { ok: false, error: "no patch" };
log("applyPatch", applied);

return { n: s.data && s.data.n, a: a.output, b: b.output, isolated: w.ok, applied, failures: [s, a, b, w].filter((r) => !r.ok).map((r) => r.reason + ": " + r.error) };
`;

console.log(`smoke: model ${MODEL}, repo ${repo}`);
const t0 = Date.now();
let lastLine = "";
let runDir: string | undefined;
const { details, result } = await runWorkflow({
	runId: `smoke-${Date.now().toString(36)}`,
	name: "smoke",
	source: "inline",
	script,
	args: {},
	cwd: repo,
	agents: [agent],
	agentScope: "user",
	projectAgentsDir: null,
	runner: runSingleAgent,
	piInvocation: (args) => ({ command: "pi", args }),
	worktrees: {
		createIsolatedWorktree: (root, dir, index) => {
			runDir = dir;
			return createIsolatedWorktree(root, dir, index);
		},
	},
	onProgress: (d) => {
		const running = d.agents.filter((r) => r.status === "running").length;
		const line = `  … ${d.status} spawned=${d.spawned} running=${running} cost=$${subagentCost(d).toFixed(4)}`;
		if (line !== lastLine) console.log((lastLine = line));
	},
});

const cost = subagentCost(details);
console.log("\nlogs:");
for (const l of details.logs) console.log(`  ${l}`);
console.log(`\nresult:\n${formatWorkflowResult(result)}`);
console.log(
	`\nstatus=${details.status} spawned=${details.spawned} attempts=${details.results.length} cost=$${cost.toFixed(4)} time=${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
if (details.error) console.log(`error: ${details.error}`);

try {
	assert.equal(details.status, "done");
	const r = result as { n: unknown; a: string; b: string; isolated: boolean; applied: { ok: boolean } };
	assert.equal(r.n, 42);
	assert.match(r.a, /alpha/i);
	assert.match(r.b, /beta/i);
	assert.equal(r.isolated, true);
	assert.deepEqual(r.applied, { ok: true });
	assert.equal(fs.readFileSync(path.join(repo, "SMOKE.txt"), "utf8").trim(), "hello");
	assert.ok(cost > 0, "non-zero cost");
	assert.equal(git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
	assert.ok(runDir, "a worktree was created");
	assert.equal(fs.existsSync(runDir), false, "run dir swept");
	console.log("\nSMOKE OK");
} finally {
	fs.rmSync(repo, { recursive: true, force: true });
}
