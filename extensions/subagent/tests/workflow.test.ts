/** Workflow runtime (workflow.ts + worker source) against a fake child runner. No git, no pi children. */

import assert from "node:assert/strict";
import * as os from "node:os";
import { after, describe, test } from "node:test";
import { subagentCost, type WorkflowAgentResult, type WorkflowDetails } from "../types.ts";
import { composeWorkflowTask, formatWorkflowResult, parseFollowUps, runWorkflow, type WorkflowRunOptions } from "../workflow.ts";
import { type FakePlan, type FakeReply, makeFakeRunner, nextRunId, testAgents } from "./fake-runner.ts";

const unhandled: unknown[] = [];
const onUnhandled = (err: unknown) => unhandled.push(err);
process.on("unhandledRejection", onUnhandled);
after(() => {
	process.off("unhandledRejection", onUnhandled);
	assert.deepEqual(unhandled, [], "no unhandled rejections during workflow tests");
});

function run(script: string, plan: FakePlan | FakeReply = {}, extra: Partial<WorkflowRunOptions> = {}) {
	const fake = makeFakeRunner(plan);
	const outcome = runWorkflow({
		runId: nextRunId(),
		name: "inline",
		source: "inline",
		script,
		args: {},
		cwd: os.tmpdir(),
		agents: testAgents(),
		agentScope: "user",
		projectAgentsDir: null,
		runner: fake.runner,
		...extra,
	});
	return { fake, outcome };
}

function assertDone(details: WorkflowDetails) {
	assert.equal(details.status, "done", `workflow failed: ${details.error}`);
}

describe("script return value and args", () => {
	test("returns the script's value", async () => {
		const { outcome } = run(`const r = await agent("hi"); return { out: r.output, ok: r.ok, n: [1, 2] };`, { output: "hello" });
		const { details, result } = await outcome;
		assertDone(details);
		assert.deepEqual(result, { out: "hello", ok: true, n: [1, 2] });
		assert.equal(details.spawned, 1);
		assert.ok(details.endedAt && details.endedAt >= details.startedAt);
	});

	test("formatWorkflowResult: string as is, object as JSON, undefined placeholder", () => {
		assert.equal(formatWorkflowResult("# report"), "# report");
		assert.equal(formatWorkflowResult({ a: 1 }), '{\n  "a": 1\n}');
		assert.equal(formatWorkflowResult(undefined), "(no return value)");
	});

	// Shallow freeze of a structured clone (per plan): nested edits stay inside the worker.
	test("args pass through, frozen at the top level, host copy untouched", async () => {
		const script = `
			const before = args.base;
			try { args.base = "changed"; } catch {}
			try { args.nested.x = 2; } catch {}
			return { before, after: args.base, frozen: Object.isFrozen(args), nested: args.nested.x };`;
		const { details, result } = await run(script, {}, { args: { base: "main", nested: { x: 1 } } }).outcome;
		assertDone(details);
		assert.deepEqual(result, { before: "main", after: "main", frozen: true, nested: 2 });
		assert.deepEqual(details.args, { base: "main", nested: { x: 1 } });
	});

	test("missing args default to an empty frozen object", async () => {
		const { details, result } = await run(`return [Object.keys(args).length, Object.isFrozen(args)];`, {}, { args: undefined }).outcome;
		assertDone(details);
		assert.deepEqual(result, [0, true]);
	});
});

describe("logs and phases", () => {
	test("log/console land in details.logs; phases track counts", async () => {
		const script = `
			log("start", { x: 1 }, 2);
			console.warn("warned");
			await phase("one", async () => {
				await parallel([agent("a"), agent("b")]);
			});
			await phase("two", async () => {
				await agent("c", { agent: "ghost" });
				await agent("d", { agent: "fails" });
			});
			return "ok";`;
		const plan: FakePlan = (spec) => (spec.agentName === "fails" ? { stopReason: "error", errorMessage: "boom" } : {});
		const agents = [...testAgents(), { ...testAgents()[0], name: "fails" }];
		const { details } = await run(script, plan, { agents }).outcome;
		assertDone(details);
		assert.deepEqual(details.logs, ['start {"x":1} 2', "warned"]);
		assert.equal(details.phases.length, 2);
		const [one, two] = details.phases;
		assert.deepEqual(
			{ name: one.name, status: one.status, spawned: one.spawned, done: one.done, failed: one.failed },
			{ name: "one", status: "done", spawned: 2, done: 2, failed: 0 },
		);
		// unknown agent: failed without spawning; failing child: spawned and failed
		assert.deepEqual(
			{ name: two.name, status: two.status, spawned: two.spawned, done: two.done, failed: two.failed },
			{ name: "two", status: "done", spawned: 1, done: 0, failed: 2 },
		);
		assert.ok(one.endedAt !== undefined && two.endedAt !== undefined);
		assert.deepEqual(
			details.agents.map((a) => [a.agent, a.phase, a.status]),
			[
				["general", "one", "done"],
				["general", "one", "done"],
				["ghost", "two", "failed"],
				["fails", "two", "failed"],
			],
		);
		assert.equal(details.spawned, 3);
	});

	test("nested phases restore the outer phase", async () => {
		const script = `
			return await phase("outer", async () => {
				await phase("inner", () => agent("x"));
				const r = await agent("y");
				return r.phase;
			});`;
		const { details, result } = await run(script).outcome;
		assertDone(details);
		assert.equal(result, "outer");
		assert.deepEqual(
			details.agents.map((a) => a.phase),
			["inner", "outer"],
		);
	});

	test("onProgress receives running snapshots and the final state", async () => {
		const seen: WorkflowDetails[] = [];
		const { details } = await run(`log("x"); await agent("a"); return 1;`, {}, { onProgress: (d) => seen.push(d) }).outcome;
		assertDone(details);
		assert.ok(seen.some((d) => d.status === "running"));
		assert.equal(seen.at(-1)?.status, "done");
	});
});

describe("concurrency", () => {
	const script = `return (await parallel(Array.from({ length: 40 }, (_, i) => i), (i) => agent("task " + i))).filter((r) => r.ok).length;`;

	test("default cap is 16", async () => {
		const { fake, outcome } = run(script, { delayMs: 20 });
		const { details, result } = await outcome;
		assertDone(details);
		assert.equal(result, 40);
		assert.equal(fake.specs.length, 40);
		assert.equal(fake.maxInFlight, 16);
		assert.equal(details.spawned, 40);
	});

	test("custom cap", async () => {
		const { fake, outcome } = run(script, { delayMs: 5 }, { concurrency: 2 });
		const { details, result } = await outcome;
		assertDone(details);
		assert.equal(result, 40);
		assert.equal(fake.maxInFlight, 2);
	});
});

describe("child specs", () => {
	test("every child gets forced tool exclusions and composed instructions", async () => {
		const { fake, outcome } = run(`await agent("one"); await agent("two", { agent: "scout" }); return 1;`);
		const { details } = await outcome;
		assertDone(details);
		assert.equal(fake.specs.length, 2);
		for (const spec of fake.specs) {
			assert.ok(spec.extraExcludedTools?.includes("spawn"));
			assert.ok(spec.extraExcludedTools?.includes("subagent"));
			assert.ok(spec.task.includes("<workflow-instructions>"));
			// cursor agents are not offered for follow-ups
			assert.ok(spec.task.includes("one of: general, scout)"), spec.task);
		}
		assert.equal(fake.specs[1].agentName, "scout");
	});

	test("default agent is general", async () => {
		const { fake, outcome } = run(`const r = await agent("hi"); return r.agent;`);
		const { details, result } = await outcome;
		assertDone(details);
		assert.equal(result, "general");
		assert.equal(fake.specs[0].agentName, "general");
	});

	test("composeWorkflowTask starts with the prompt", () => {
		const task = composeWorkflowTask("do it", ["a", "b"]);
		assert.ok(task.startsWith("do it\n"));
		assert.ok(task.includes("one of: a, b"));
		assert.ok(!task.includes("JSON Schema"));
		assert.ok(composeWorkflowTask("x", ["a"], { type: "object" }).includes('{"type":"object"}'));
	});

	test("usage cost of every attempt lands in details.results", async () => {
		const { details, result } = await run(`const r = await agent("a"); await agent("b"); return r.usage.cost;`, { cost: 0.25 }).outcome;
		assertDone(details);
		assert.equal(result, 0.25);
		assert.equal(details.results.length, 2);
		assert.equal(subagentCost(details), 0.5);
		assert.deepEqual(details.results[0].messages, []);
	});
});

describe("failures come back as values", () => {
	test("failed child, unknown agent, cursor agent; script continues", async () => {
		const script = `
			const failed = await agent("x", { label: "L" });
			const unknown = await agent("x", { agent: "ghost" });
			const cursor = await agent("x", { agent: "cross" });
			const fine = await agent("y");
			return { failed, unknown, cursor, fine };`;
		const plan: FakePlan = (_spec, i) => (i === 0 ? { stopReason: "error", errorMessage: "child blew up", output: "partial" } : {});
		const { fake, outcome } = run(script, plan);
		const { details, result } = await outcome;
		assertDone(details);
		const r = result as Record<string, WorkflowAgentResult>;
		assert.equal(r.failed.ok, false);
		assert.equal(r.failed.reason, "error");
		assert.equal(r.failed.error, "child blew up");
		assert.equal(r.failed.label, "L");
		assert.equal(r.failed.attempts, 1);
		assert.equal(r.unknown.ok, false);
		assert.equal(r.unknown.reason, "unknown-agent");
		assert.match(r.unknown.error ?? "", /Unknown agent "ghost"/);
		assert.equal(r.cursor.ok, false);
		assert.equal(r.cursor.reason, "unknown-agent");
		assert.match(r.cursor.error ?? "", /cursor/);
		assert.equal(r.fine.ok, true);
		// unknown/cursor never reach the runner and are not counted as spawned
		assert.equal(fake.specs.length, 2);
		assert.equal(details.spawned, 2);
	});

	test("invalid options fail the call, not the script", async () => {
		const script = `
			const t = await agent("x", { timeout: -1 });
			const s = await agent("x", { schema: [1] });
			const i = await agent("x", { isolation: "docker" });
			return [t.reason, s.reason, i.reason];`;
		const { fake, outcome } = run(script);
		const { details, result } = await outcome;
		assertDone(details);
		assert.deepEqual(result, ["error", "error", "isolation"]);
		assert.equal(fake.specs.length, 0);
	});

	test("agent() misuse throws in the script", async () => {
		const { details } = await run(`await agent(42);`).outcome;
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", /prompt must be a non-empty string/);
	});

	test("isolation outside a git repo → reason isolation", async () => {
		const { fake, outcome } = run(`return await agent("x", { isolation: "worktree" });`, {}, {
			worktrees: { getRepoRoot: async () => null },
		});
		const { details, result } = await outcome;
		assertDone(details);
		assert.equal((result as WorkflowAgentResult).reason, "isolation");
		assert.equal(fake.specs.length, 0);
	});
});

describe("timeout", () => {
	test("aborts the child and reports reason timeout", async () => {
		const started = Date.now();
		const { fake, outcome } = run(`return await agent("slow", { timeout: 50 });`, { delayMs: 500 });
		const { details, result } = await outcome;
		assertDone(details);
		const r = result as WorkflowAgentResult;
		assert.equal(r.ok, false);
		assert.equal(r.reason, "timeout");
		assert.match(r.error ?? "", /Timed out after 50 ms/);
		assert.equal(fake.specs[0].signal?.aborted, true);
		assert.ok(Date.now() - started < 450, "did not wait for the child's full delay");
	});

	test("a timeout that does not fire leaves the call ok", async () => {
		const { details, result } = await run(`return (await agent("fast", { timeout: 5000 })).ok;`, { delayMs: 5 }).outcome;
		assertDone(details);
		assert.equal(result, true);
	});
});

describe("abort", () => {
	test("external abort settles fast, signals every child, and leaves nothing pending", async () => {
		const ac = new AbortController();
		const script = `
			await parallel(Array.from({ length: 6 }, (_, i) => i), (i) => agent("t" + i));
			return "unreachable";`;
		const { fake, outcome } = run(script, { delayMs: 30_000 }, { signal: ac.signal, concurrency: 3 });
		await fake.waitForCalls(3);
		const t0 = Date.now();
		ac.abort();
		const { details, result } = await outcome;
		const elapsed = Date.now() - t0;
		assert.ok(elapsed < 1000, `aborted in ${elapsed} ms`);
		assert.equal(details.status, "aborted");
		assert.equal(result, undefined);
		assert.equal(fake.specs.length, 3, "queued calls never started");
		assert.ok(fake.specs.every((s) => s.signal?.aborted));
		assert.equal(fake.inFlight, 0);
		assert.equal(fake.aborted, 3);
		assert.ok(details.agents.every((a) => a.status === "failed" || a.status === "queued"));
		// give stray promise rejections a chance to surface
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(unhandled, []);
	});

	test("already-aborted signal finishes immediately without running the script", async () => {
		const ac = new AbortController();
		ac.abort();
		const { fake, outcome } = run(`await agent("x"); return 1;`, {}, { signal: ac.signal });
		const { details } = await outcome;
		assert.equal(details.status, "aborted");
		assert.equal(fake.specs.length, 0);
	});

	test("script finishing with agents still in flight aborts them", async () => {
		const { fake, outcome } = run(`agent("dangling"); await agent("quick"); return "done";`, (_s, i) => ({
			delayMs: i === 0 ? 30_000 : 5,
		}));
		const t0 = Date.now();
		const { details, result } = await outcome;
		assertDone(details);
		assert.equal(result, "done");
		assert.ok(Date.now() - t0 < 1000);
		assert.equal(fake.specs[0].signal?.aborted, true);
		assert.equal(fake.inFlight, 0);
	});
});

describe("schema", () => {
	const schema = `{ type: "object", properties: { n: { type: "number" } }, required: ["n"] }`;

	test("invalid then valid → attempts 2 and parsed data", async () => {
		const plan: FakePlan = (_s, i) => ({ output: i === 0 ? "sure, here it is: n is 42" : 'done\n```json\n{"n": 42}\n```' });
		const { fake, outcome } = run(`return await agent("n?", { schema: ${schema} });`, plan);
		const { details, result } = await outcome;
		assertDone(details);
		const r = result as WorkflowAgentResult;
		assert.equal(r.ok, true);
		assert.equal(r.attempts, 2);
		assert.deepEqual(r.data, { n: 42 });
		assert.equal(details.results.length, 2);
		assert.equal(details.agents[0].attempts, 2);
		assert.ok(fake.specs[0].task.includes("JSON Schema"));
		assert.ok(fake.specs[1].task.includes("<validation-errors>"));
		assert.ok(fake.specs[1].task.includes("<previous-attempt>\nsure, here it is"));
		assert.equal(r.usage.cost, 0.002, "usage summed across attempts");
	});

	test("never valid → ok:false, reason schema, attempts 4", async () => {
		const { fake, outcome } = run(`return await agent("n?", { schema: ${schema} });`, { output: '```json\n{"n": "x"}\n```' });
		const { details, result } = await outcome;
		assertDone(details);
		const r = result as WorkflowAgentResult;
		assert.equal(r.ok, false);
		assert.equal(r.reason, "schema");
		assert.equal(r.attempts, 4);
		assert.match(r.error ?? "", /\/n/);
		assert.equal(fake.specs.length, 4);
		assert.equal(details.results.length, 4);
		assert.equal(details.spawned, 1, "retries count as one agent() call");
	});

	test("a child failure during retries ends the loop with that reason", async () => {
		const plan: FakePlan = (_s, i) => (i === 0 ? { output: "nope" } : { stopReason: "error", errorMessage: "crash" });
		const { fake, outcome } = run(`return await agent("n?", { schema: ${schema} });`, plan);
		const { result } = await outcome;
		const r = result as WorkflowAgentResult;
		assert.equal(r.reason, "error");
		assert.equal(r.attempts, 2);
		assert.equal(fake.specs.length, 2);
	});
});

describe("follow-ups", () => {
	const agents = ["general", "scout"];

	test("parsed, stripped, unknown/malformed entries dropped", () => {
		const out =
			'Did the thing.\n\n```followups\n[{"task": "check it", "agent": "scout"}, {"task": "x", "agent": "ghost"}, {"agent": "scout"}, {"task": "  ", "agent": "general"}, 7]\n```\n';
		const { output, followUps } = parseFollowUps(out, agents);
		assert.equal(output, "Did the thing.");
		assert.deepEqual(followUps, [{ task: "check it", agent: "scout" }]);
	});

	test("malformed fence → no follow-ups, output intact", () => {
		const out = "text\n```followups\n[{task: nope}\n```";
		assert.deepEqual(parseFollowUps(out, agents), { output: out, followUps: [] });
		const notArray = 'text\n```followups\n{"task": "a", "agent": "scout"}\n```';
		assert.deepEqual(parseFollowUps(notArray, agents), { output: notArray, followUps: [] });
	});

	test("fence not at the end is left alone", () => {
		const out = '```followups\n[{"task": "a", "agent": "scout"}]\n```\nmore text';
		assert.deepEqual(parseFollowUps(out, agents), { output: out, followUps: [] });
	});

	test("through runWorkflow", async () => {
		const { details, result } = await run(`return await agent("x");`, {
			output: 'answer\n```followups\n[{"task": "more", "agent": "general"}, {"task": "c", "agent": "cross"}]\n```',
		}).outcome;
		assertDone(details);
		const r = result as WorkflowAgentResult;
		assert.equal(r.output, "answer");
		assert.deepEqual(r.followUps, [{ task: "more", agent: "general" }], "cursor agents are not valid follow-up targets");
	});
});

describe("script errors", () => {
	test("throw → failed with message and workflow.js line", async () => {
		const { details } = await run(`log("a");\n\nthrow new Error("boom");`).outcome;
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", /boom/);
		assert.match(details.error ?? "", /workflow\.js:3/);
		assert.deepEqual(details.logs, ["a"]);
	});

	test("syntax error → failed, mentions workflow.js", async () => {
		const { details } = await run(`const x = ;\nreturn x;`).outcome;
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", /SyntaxError/);
		assert.match(details.error ?? "", /workflow\.js/);
	});

	test("non-serializable return → failed mentioning serialization", async () => {
		const { details } = await run(`return { f: () => 1 };`).outcome;
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", /serialized/);
	});

	test("sandbox has no require/process/setTimeout", async () => {
		const { details, result } = await run(`return [typeof require, typeof process, typeof setTimeout, typeof fetch];`).outcome;
		assertDone(details);
		assert.deepEqual(result, ["undefined", "undefined", "undefined", "undefined"]);
	});

	test("unhandled rejection inside the script fails the run", async () => {
		const { details } = await run(`Promise.reject(new Error("floating")); await agent("x", { }); return 1;`, { delayMs: 50 }).outcome;
		assert.equal(details.status, "failed");
		assert.match(details.error ?? "", /floating/);
	});
});

describe("applyPatch", () => {
	test("dispatches to the injected implementation", async () => {
		const patches: string[] = [];
		const script = `return [await applyPatch("diff --git a b"), await applyPatch(42)];`;
		const { details, result } = await run(script, {}, {
			applyPatch: async (patch) => {
				patches.push(patch);
				return { ok: false, error: "conflict in a.txt" };
			},
		}).outcome;
		assertDone(details);
		const [a, b] = result as { ok: boolean; error?: string }[];
		assert.deepEqual(a, { ok: false, error: "conflict in a.txt" });
		assert.equal(b.ok, false);
		assert.match(b.error ?? "", /must be a string/);
		assert.deepEqual(patches, ["diff --git a b"]);
	});

	test("a throwing implementation becomes {ok:false}", async () => {
		const { details, result } = await run(`return await applyPatch("p");`, {}, {
			applyPatch: async () => {
				throw new Error("disk full");
			},
		}).outcome;
		assertDone(details);
		assert.deepEqual(result, { ok: false, error: "disk full" });
	});
});

describe("parallel and pipeline", () => {
	test("parallel(items, fn) preserves order regardless of finish order", async () => {
		const script = `
			const rs = await parallel([3, 1, 2], (n, i) => agent("n" + n + " i" + i));
			return rs.map((r) => r.output);`;
		const plan: FakePlan = (spec) => {
			const n = Number(/^n(\d)/.exec(spec.task)?.[1]);
			return { delayMs: n * 15, output: spec.task.split("\n")[0] };
		};
		const { details, result } = await run(script, plan).outcome;
		assertDone(details);
		assert.deepEqual(result, ["n3 i0", "n1 i1", "n2 i2"]);
	});

	test("parallel of thunks, promises, and plain values", async () => {
		const script = `return await parallel([() => 1, Promise.resolve(2), 3, async () => 4]);`;
		const { details, result } = await run(script).outcome;
		assertDone(details);
		assert.deepEqual(result, [1, 2, 3, 4]);
	});

	test("pipeline threads values through stages sequentially", async () => {
		const script = `
			return await pipeline([
				(x, i) => x + ":" + i,
				async (x, i) => (await agent(x)).output + ":" + i,
				(x) => x.toUpperCase(),
			], "start");`;
		const { fake, outcome } = run(script, (spec) => ({ output: spec.task.split("\n")[0] + "!" }));
		const { details, result } = await outcome;
		assertDone(details);
		assert.equal(result, "START:0!:1");
		assert.equal(fake.specs.length, 1);
	});
});
