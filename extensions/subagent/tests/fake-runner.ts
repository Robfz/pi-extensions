/** Test doubles for the workflow runtime: a scripted ChildRunner and in-memory agent configs. */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../agents.ts";
import type { RunSpec } from "../runner.ts";
import { emptyUsage, type SingleResult } from "../types.ts";
import type { ChildRunner } from "../workflow.ts";

export interface FakeReply {
	/** Final assistant text. */
	output?: string;
	/** Defaults to "stop"; "error" makes the result a failure. */
	stopReason?: string;
	exitCode?: number;
	errorMessage?: string;
	/** Resolve after this many ms unless the signal aborts first; default 0. */
	delayMs?: number;
	cost?: number;
	/** Runs before the delay, e.g. to write into `spec.defaultCwd`. */
	effect?: (spec: RunSpec) => void | Promise<void>;
}

/** Reply for the n-th runner call (0-based, across the whole run). */
export type FakePlan = (spec: RunSpec, callIndex: number) => FakeReply | Promise<FakeReply>;

export interface FakeRunner {
	runner: ChildRunner;
	/** Every spec the runner received, in call order. */
	specs: RunSpec[];
	readonly inFlight: number;
	readonly maxInFlight: number;
	/** Calls that ended because their signal aborted. */
	readonly aborted: number;
	/** Resolves once at least `n` calls have started. */
	waitForCalls(n: number): Promise<void>;
}

export function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake",
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as Message;
}

export function makeFakeRunner(plan: FakePlan | FakeReply = {}): FakeRunner {
	const specs: RunSpec[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let aborted = 0;
	const waiters: { n: number; resolve: () => void }[] = [];

	const runner: ChildRunner = async (spec) => {
		const index = specs.length;
		specs.push(spec);
		for (const w of waiters.splice(0)) {
			if (specs.length >= w.n) w.resolve();
			else waiters.push(w);
		}
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			const reply = typeof plan === "function" ? await plan(spec, index) : plan;
			await reply.effect?.(spec);
			const wasAborted = await sleepOrAbort(reply.delayMs ?? 0, spec.signal);
			const result: SingleResult = {
				agent: spec.agentName,
				agentSource: "user",
				task: spec.task,
				exitCode: reply.exitCode ?? 0,
				messages: [],
				stderr: "",
				usage: { ...emptyUsage(), cost: reply.cost ?? 0.001, turns: 1 },
				model: "fake-model",
				durationMs: reply.delayMs ?? 0,
				stopReason: reply.stopReason ?? "stop",
				errorMessage: reply.errorMessage,
			};
			if (wasAborted) {
				aborted++;
				result.stopReason = "aborted";
				result.errorMessage = "Subagent was aborted";
				return result;
			}
			result.messages.push(assistantMessage(reply.output ?? `ok:${index}`));
			spec.onUpdate?.(result);
			return result;
		} finally {
			inFlight--;
		}
	};

	return {
		runner,
		specs,
		get inFlight() {
			return inFlight;
		},
		get maxInFlight() {
			return maxInFlight;
		},
		get aborted() {
			return aborted;
		},
		waitForCalls(n) {
			if (specs.length >= n) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ n, resolve }));
		},
	};
}

/** Resolves `true` if the signal aborted before `ms` elapsed. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(true);
	if (ms <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function piAgent(name: string, extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} test agent`,
		runner: "pi",
		systemPrompt: "",
		source: "user",
		filePath: "<memory>",
		...extra,
	};
}

/** general + scout (pi) and cross (cursor). */
export function testAgents(): AgentConfig[] {
	return [
		piAgent("general"),
		piAgent("scout", { excludedTools: ["write"] }),
		{ ...piAgent("cross"), runner: "cursor" },
	];
}

let runCounter = 0;
export function nextRunId(): string {
	return `test-${process.pid}-${Date.now().toString(36)}-${++runCounter}`;
}
