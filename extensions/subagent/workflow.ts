/**
 * Workflow runtime host: runs a workflow script in a worker thread (see workflow-worker-source.ts)
 * and serves its `agent()` / `applyPatch()` calls by running pi child agents under a concurrency cap.
 * Runtime-imports only node built-ins and types.ts, so tests can load it with a fake runner.
 */

import { Worker } from "node:worker_threads";
import type { AgentConfig } from "./agents.ts";
import type { RunSpec } from "./runner.ts";
import {
	type AgentScope,
	DEFAULT_WORKFLOW_AGENT,
	DEFAULT_WORKFLOW_CONCURRENCY,
	emptyUsage,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type UsageStats,
	type WorkerToHost,
	WORKFLOW_CHILD_EXCLUDED_TOOLS,
	type WorkflowAgentCall,
	type WorkflowAgentResult,
	type WorkflowAgentRow,
	type WorkflowDetails,
	type WorkflowFailReason,
	type WorkflowFollowUp,
	type WorkflowPhase,
	type WorkflowStatus,
} from "./types.ts";
import { WORKFLOW_WORKER_SOURCE } from "./workflow-worker-source.ts";

export { WORKFLOW_CHILD_EXCLUDED_TOOLS } from "./types.ts";

export type ChildRunner = (spec: RunSpec) => Promise<SingleResult>;

export type ApplyPatchResult = { ok: true } | { ok: false; error: string };

export interface WorkflowRunOptions {
	runId: string;
	name: string;
	source: WorkflowDetails["source"];
	script: string;
	args: unknown;
	cwd: string;
	agents: AgentConfig[];
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	/** Max concurrent child agents; default DEFAULT_WORKFLOW_CONCURRENCY. */
	concurrency?: number;
	signal?: AbortSignal;
	runner: ChildRunner;
	onProgress?: (details: WorkflowDetails) => void;
	piInvocation?: RunSpec["piInvocation"];
}

export interface WorkflowRunOutcome {
	details: WorkflowDetails;
	/** Script return value; undefined unless status is "done". */
	result?: unknown;
}

const MAX_STORED_LOGS = 500;
const MAX_LOG_CHARS = 2048;
const PROGRESS_INTERVAL_MS = 250;
const WORKER_HEAP_MB = 1024;

export function formatWorkflowResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === undefined) return "(no return value)";
	return JSON.stringify(result, null, 2) ?? String(result);
}

const FOLLOWUPS_FENCE = /```followups[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/;

/** Splits a trailing ```followups fence off an agent's output; malformed fences leave the output intact. */
export function parseFollowUps(output: string, knownAgents: string[]): { output: string; followUps: WorkflowFollowUp[] } {
	const match = FOLLOWUPS_FENCE.exec(output);
	if (!match) return { output, followUps: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch {
		return { output, followUps: [] };
	}
	if (!Array.isArray(parsed)) return { output, followUps: [] };
	const known = new Set(knownAgents);
	const followUps: WorkflowFollowUp[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const { task, agent } = item as Record<string, unknown>;
		if (typeof task !== "string" || !task.trim() || typeof agent !== "string" || !known.has(agent)) continue;
		followUps.push({ task, agent });
	}
	return { output: output.slice(0, match.index).trimEnd(), followUps };
}

export function composeWorkflowTask(prompt: string, agentNames: string[]): string {
	return `${prompt}

<workflow-instructions>
You are one step of an automated workflow and cannot spawn agents yourself. If more delegated work is needed, end your response with a fenced code block tagged \`followups\` containing a JSON array of {"task": string, "agent": string} objects (agent must be one of: ${agentNames.join(", ")}). Omit the block when nothing is needed.
</workflow-instructions>`;
}

/** FIFO counting semaphore; waiters resolve `false` once the signal aborts. */
class Semaphore {
	private available: number;
	private waiters: ((acquired: boolean) => void)[] = [];

	constructor(limit: number, signal: AbortSignal) {
		this.available = limit;
		signal.addEventListener("abort", () => {
			for (const w of this.waiters.splice(0)) w(false);
		});
	}

	acquire(signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return Promise.resolve(false);
		if (this.available > 0) {
			this.available--;
			return Promise.resolve(true);
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) next(true);
		else this.available++;
	}
}

function storedResult(r: SingleResult): SingleResult {
	return { ...r, messages: [], usage: { ...r.usage }, stderr: r.stderr.slice(-2000), task: r.task.slice(0, 500) };
}

function addUsage(into: UsageStats, from: UsageStats): void {
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
	into.cost += from.cost;
	into.turns += from.turns;
	into.contextTokens = from.contextTokens;
}

function errorLocation(stack: string | undefined): string | undefined {
	return stack?.match(/workflow\.js:\d+(?::\d+)?/)?.[0];
}

export function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowRunOutcome> {
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY));
	const piAgents = opts.agents.filter((a) => a.runner === "pi");
	const piAgentNames = piAgents.map((a) => a.name);

	const details: WorkflowDetails = {
		mode: "workflow",
		agentScope: opts.agentScope,
		projectAgentsDir: opts.projectAgentsDir,
		runId: opts.runId,
		name: opts.name,
		source: opts.source,
		script: opts.script,
		args: opts.args,
		status: "running",
		phases: [],
		agents: [],
		spawned: 0,
		logs: [],
		results: [],
		startedAt: Date.now(),
	};

	const runAbort = new AbortController();
	const sem = new Semaphore(concurrency, runAbort.signal);
	const inFlight = new Set<Promise<void>>();
	let finished = false;
	let scriptResult: unknown;
	let worker: Worker | undefined;
	let resolveOutcome!: (o: WorkflowRunOutcome) => void;
	const outcome = new Promise<WorkflowRunOutcome>((r) => {
		resolveOutcome = r;
	});

	// ── progress ──
	let emitTimer: NodeJS.Timeout | undefined;
	const snapshot = (): WorkflowDetails => ({
		...details,
		phases: details.phases.map((p) => ({ ...p })),
		agents: details.agents.map((a) => ({ ...a })),
		logs: [...details.logs],
		results: [...details.results],
	});
	const emitNow = () => {
		clearTimeout(emitTimer);
		emitTimer = undefined;
		if (!finished) opts.onProgress?.(snapshot());
	};
	const emitThrottled = () => {
		if (emitTimer || finished) return;
		emitTimer = setTimeout(emitNow, PROGRESS_INTERVAL_MS);
	};

	const post = (msg: unknown) => {
		if (finished || !worker) return;
		try {
			worker.postMessage(msg);
		} catch {
			/* worker already gone */
		}
	};

	// ── agent calls ──
	const failedResult = (call: WorkflowAgentCall, agent: string, reason: WorkflowFailReason, error: string): WorkflowAgentResult => ({
		ok: false,
		agent,
		label: call.label,
		phase: call.phase,
		output: "",
		error,
		reason,
		followUps: [],
		attempts: 0,
		usage: emptyUsage(),
		durationMs: 0,
	});

	/** Checks a call before it takes a slot; returns a failure result when it cannot run. */
	const precheck = (call: WorkflowAgentCall, agentName: string): WorkflowAgentResult | undefined => {
		const agent = opts.agents.find((a) => a.name === agentName);
		if (!agent) {
			return failedResult(call, agentName, "unknown-agent", `Unknown agent "${agentName}". Available: ${piAgentNames.join(", ") || "none"}`);
		}
		if (agent.runner !== "pi") {
			return failedResult(call, agentName, "unknown-agent", `Agent "${agentName}" runs on ${agent.runner}; workflows run pi agents only`);
		}
		// Phase C removes these checks when runCall implements the options.
		if (call.schema !== undefined) return failedResult(call, agentName, "error", "agent() option `schema` is not available yet");
		if (call.timeout !== undefined) return failedResult(call, agentName, "error", "agent() option `timeout` is not available yet");
		if (call.isolation !== undefined) return failedResult(call, agentName, "error", "agent() option `isolation` is not available yet");
		return undefined;
	};

	/** Runs one child process for `row`, recording its live and final usage in `details.results`. */
	const runAttempt = async (row: WorkflowAgentRow, spec: { task: string; cwd: string; signal: AbortSignal }): Promise<SingleResult> => {
		const baseCost = row.cost;
		row.attempts++;
		const idx =
			details.results.push({
				agent: row.agent,
				agentSource: "unknown",
				task: spec.task.slice(0, 500),
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
			}) - 1;
		const record = (r: SingleResult) => {
			details.results[idx] = storedResult(r);
			row.cost = baseCost + r.usage.cost;
		};
		const result = await opts.runner({
			defaultCwd: spec.cwd,
			agents: opts.agents,
			agentName: row.agent,
			task: spec.task,
			signal: spec.signal,
			extraExcludedTools: WORKFLOW_CHILD_EXCLUDED_TOOLS,
			piInvocation: opts.piInvocation,
			onUpdate: (partial) => {
				record(partial);
				emitThrottled();
			},
		});
		record(result);
		return result;
	};

	/**
	 * Runs one `agent()` call inside its concurrency slot and maps the child result for the script.
	 * Phase C hook: per-call timeout, worktree isolation (cwd + patch), and the schema retry loop
	 * around runAttempt belong here.
	 */
	const runCall = async (call: WorkflowAgentCall, row: WorkflowAgentRow): Promise<WorkflowAgentResult> => {
		const startedAt = Date.now();
		const r = await runAttempt(row, {
			task: composeWorkflowTask(call.prompt, piAgentNames),
			cwd: opts.cwd,
			signal: runAbort.signal,
		});
		const failed = isFailedResult(r);
		const { output, followUps } = parseFollowUps(getFinalOutput(r.messages), piAgentNames);
		const usage = emptyUsage();
		addUsage(usage, r.usage);
		return {
			ok: !failed,
			agent: row.agent,
			label: call.label,
			phase: call.phase,
			output,
			...(failed ? { error: getResultOutput(r), reason: r.stopReason === "aborted" ? ("aborted" as const) : ("error" as const) } : {}),
			followUps,
			attempts: row.attempts,
			usage,
			model: r.model,
			durationMs: r.durationMs ?? Date.now() - startedAt,
		};
	};

	const handleAgent = async (id: number, raw: WorkflowAgentCall): Promise<void> => {
		const call: WorkflowAgentCall = { ...raw, prompt: typeof raw?.prompt === "string" ? raw.prompt : "" };
		const agentName = typeof call.agent === "string" && call.agent ? call.agent : DEFAULT_WORKFLOW_AGENT;
		const phaseIndex = call.phase ? findRunningPhase(call.phase) : -1;
		const phase = phaseIndex >= 0 ? details.phases[phaseIndex] : undefined;
		const row: WorkflowAgentRow = {
			id: details.agents.length + 1,
			agent: agentName,
			label: typeof call.label === "string" ? call.label : undefined,
			phase: call.phase,
			status: "queued",
			attempts: 0,
			cost: 0,
			isolated: call.isolation === "worktree" || undefined,
			phaseIndex: phase ? phaseIndex : undefined,
		};
		details.agents.push(row);

		const settle = (value: WorkflowAgentResult) => {
			row.status = value.ok ? "done" : "failed";
			row.reason = value.reason;
			row.error = value.error?.slice(0, 500);
			row.endedAt = Date.now();
			if (phase) {
				if (value.ok) phase.done++;
				else phase.failed++;
			}
			emitNow();
			post({ type: "response", id, ok: true, value });
		};

		const invalid = !call.prompt.trim()
			? failedResult(call, agentName, "error", "agent(): prompt must be a non-empty string")
			: precheck(call, agentName);
		if (invalid) {
			settle(invalid);
			return;
		}

		emitNow();
		if (!(await sem.acquire(runAbort.signal))) {
			settle(failedResult(call, agentName, "aborted", "Workflow aborted before the agent started"));
			return;
		}
		let value: WorkflowAgentResult;
		try {
			row.status = "running";
			row.startedAt = Date.now();
			details.spawned++;
			if (phase) phase.spawned++;
			emitNow();
			value = await runCall(call, row);
		} catch (err) {
			value = failedResult(call, agentName, "error", err instanceof Error ? err.message : String(err));
		} finally {
			sem.release();
		}
		settle(value);
	};

	const handleApplyPatch = async (id: number, _params: { patch: string }): Promise<void> => {
		const value: ApplyPatchResult = { ok: false, error: "applyPatch not available" };
		post({ type: "response", id, ok: true, value });
	};

	const track = (p: Promise<void>) => {
		inFlight.add(p);
		const untrack = () => inFlight.delete(p);
		p.then(untrack, untrack);
	};

	// ── phases & logs ──
	/** Index of the latest running phase named `name`, or -1. */
	const findRunningPhase = (name: string): number => {
		for (let i = details.phases.length - 1; i >= 0; i--) {
			const p = details.phases[i];
			if (p.name === name && p.status === "running") return i;
		}
		return -1;
	};

	const onMessage = (msg: WorkerToHost) => {
		if (finished || !msg || typeof msg !== "object") return;
		switch (msg.type) {
			case "call":
				if (msg.method === "agent") track(handleAgent(msg.id, msg.params));
				else if (msg.method === "applyPatch") track(handleApplyPatch(msg.id, msg.params));
				else post({ type: "response", id: (msg as { id: number }).id, ok: false, error: "unknown method" });
				return;
			case "log": {
				const text = String(msg.text);
				details.logs.push(text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}…` : text);
				if (details.logs.length > MAX_STORED_LOGS) details.logs.splice(0, details.logs.length - MAX_STORED_LOGS);
				emitNow();
				return;
			}
			case "phase":
				if (msg.event === "start") {
					details.phases.push({ name: msg.name, status: "running", startedAt: Date.now(), spawned: 0, done: 0, failed: 0 });
				} else {
					const p = details.phases[findRunningPhase(msg.name)];
					if (p) {
						p.status = "done";
						p.endedAt = Date.now();
					}
				}
				emitNow();
				return;
			case "done":
				scriptResult = msg.result;
				void finish("done");
				return;
			case "error": {
				const loc = errorLocation(msg.stack);
				const message = loc && !msg.message.includes("workflow.js") ? `${msg.message} (at ${loc})` : msg.message;
				void finish("failed", message);
				return;
			}
		}
	};

	// ── lifecycle ──
	const finish = async (status: Exclude<WorkflowStatus, "pending-approval" | "canceled" | "running">, error?: string) => {
		if (finished) return;
		finished = true;
		clearTimeout(emitTimer);
		opts.signal?.removeEventListener("abort", onExternalAbort);
		details.status = status;
		if (error) details.error = error;
		const w = worker;
		worker = undefined;
		// Nothing awaits calls still running once the script is over: stop them.
		runAbort.abort();
		await Promise.allSettled([w?.terminate(), ...inFlight]);
		while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		details.endedAt = Date.now();
		opts.onProgress?.(snapshot());
		resolveOutcome({ details: snapshot(), result: status === "done" ? scriptResult : undefined });
	};

	const onExternalAbort = () => void finish("aborted", "Workflow aborted");

	if (opts.signal?.aborted) {
		void finish("aborted", "Workflow aborted");
		return outcome;
	}
	opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

	try {
		worker = new Worker(WORKFLOW_WORKER_SOURCE, {
			eval: true,
			workerData: { script: opts.script, args: opts.args ?? {} },
			resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
		});
	} catch (err) {
		void finish("failed", `Could not start workflow worker: ${err instanceof Error ? err.message : String(err)}`);
		return outcome;
	}
	worker.on("message", onMessage);
	worker.on("error", (err) => void finish("failed", err instanceof Error ? err.message : String(err)));
	worker.on("exit", (code) => void finish("failed", `workflow worker exited (code ${code})`));
	emitNow();
	return outcome;
}
