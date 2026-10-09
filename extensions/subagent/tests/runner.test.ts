/** runner.ts: CLI arg building and runSingleAgent's abort/SIGKILL/listener handling against a fixture child. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPiArgs, type RunSpec, runSingleAgent } from "../runner.ts";
import { getFinalOutput } from "../types.ts";
import { piAgent } from "./fake-runner.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stubborn-child.js");

/** AbortController whose signal counts live "abort" listeners. */
function countingAbort() {
	const ac = new AbortController();
	const live = new Set<unknown>();
	const add = ac.signal.addEventListener.bind(ac.signal);
	const remove = ac.signal.removeEventListener.bind(ac.signal);
	ac.signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
		if (type === "abort") live.add(fn);
		add(type, fn, opts);
	}) as AbortSignal["addEventListener"];
	ac.signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
		if (type === "abort") live.delete(fn);
		remove(type, fn, opts);
	}) as AbortSignal["removeEventListener"];
	return { ac, live };
}

function spec(extra: Partial<RunSpec> & { quick?: boolean; seen?: string[][] }): RunSpec {
	const { quick, seen, ...rest } = extra;
	return {
		defaultCwd: process.cwd(),
		agents: [piAgent("stub", { systemPrompt: "You are a stub.", excludedTools: ["write"] })],
		agentName: "stub",
		task: "do nothing",
		extraExcludedTools: ["spawn", "subagent"],
		piInvocation: (args) => {
			seen?.push(args);
			return { command: process.execPath, args: [FIXTURE, ...(quick ? ["--quick"] : []), ...args] };
		},
		...rest,
	};
}

describe("buildPiArgs", () => {
	test("merges forced exclusions with the agent's own into a single --exclude-tools", () => {
		const agent = piAgent("a", { excludedTools: ["bash", "spawn"], tools: ["read", "bash"], model: "m-1" });
		const args = buildPiArgs(agent, ["spawn", "subagent"]);
		assert.equal(args.filter((a) => a === "--exclude-tools").length, 1);
		assert.equal(args[args.indexOf("--exclude-tools") + 1], "bash,spawn,subagent");
		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
		assert.equal(args[args.indexOf("--model") + 1], "m-1");
		assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
	});

	test("no exclusions → no flag; extras alone → flag", () => {
		assert.ok(!buildPiArgs(piAgent("a")).includes("--exclude-tools"));
		const args = buildPiArgs(piAgent("a"), ["spawn"]);
		assert.equal(args[args.indexOf("--exclude-tools") + 1], "spawn");
	});
});

describe("runSingleAgent", () => {
	test("normal child: parses output and usage, removes its abort listener, cleans the prompt file", async () => {
		const { ac, live } = countingAbort();
		const seen: string[][] = [];
		const updates: number[] = [];
		const r = await runSingleAgent(spec({ quick: true, seen, signal: ac.signal, onUpdate: (p) => updates.push(p.messages.length) }));
		assert.equal(r.exitCode, 0);
		assert.equal(r.stopReason, "stop");
		assert.equal(getFinalOutput(r.messages), "stubborn hello");
		assert.equal(r.usage.cost, 0.0125);
		assert.equal(r.usage.turns, 1);
		assert.deepEqual(updates, [1]);
		assert.equal(live.size, 0, "abort listener removed on close");

		const args = seen[0];
		assert.equal(args.filter((a) => a === "--exclude-tools").length, 1);
		assert.equal(args[args.indexOf("--exclude-tools") + 1], "write,spawn,subagent");
		assert.equal(args.at(-1), "Task: do nothing");
		const promptFile = args[args.indexOf("--append-system-prompt") + 1];
		assert.equal(fs.existsSync(promptFile), false, "temp system prompt removed");
	});

	test("stubborn child ignoring SIGTERM: abort resolves with stopReason aborted via SIGKILL, no throw", async () => {
		const { ac, live } = countingAbort();
		let started!: () => void;
		const gotOutput = new Promise<void>((r) => (started = r));
		const promise = runSingleAgent(spec({ signal: ac.signal, onUpdate: () => started() }));
		await gotOutput; // child is running and has installed its SIGTERM handler
		const t0 = Date.now();
		ac.abort();
		const r = await promise;
		const elapsed = Date.now() - t0;
		assert.equal(r.stopReason, "aborted");
		assert.equal(r.errorMessage, "Subagent was aborted");
		assert.ok(elapsed >= 4500, `SIGTERM was ignored, so SIGKILL after ~5 s (took ${elapsed} ms)`);
		assert.ok(elapsed < 6500, `resolved within ~6 s (took ${elapsed} ms)`);
		assert.equal(getFinalOutput(r.messages), "stubborn hello", "partial output kept");
		assert.equal(live.size, 0, "abort listener removed");
	});

	test("already-aborted signal → aborted result without spawning", async () => {
		const ac = new AbortController();
		ac.abort();
		const seen: string[][] = [];
		const r = await runSingleAgent(spec({ seen, signal: ac.signal }));
		assert.equal(r.stopReason, "aborted");
		assert.equal(seen.length, 0);
	});

	test("unknown agent and spawn failure return failed results", async () => {
		const unknown = await runSingleAgent(spec({ agentName: "ghost" }));
		assert.equal(unknown.exitCode, 1);
		assert.match(unknown.stderr, /Unknown agent: "ghost"/);

		const r = await runSingleAgent(spec({ piInvocation: (args) => ({ command: "/nonexistent/pi-binary", args }) }));
		assert.equal(r.exitCode, 1);
		assert.match(r.stderr, /Failed to spawn/);
	});
});
