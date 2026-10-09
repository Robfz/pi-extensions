/**
 * Workflow runtime host: runs a workflow script in a worker thread (see workflow-worker-source.ts)
 * and serves its `agent()` / `applyPatch()` calls by running pi child agents under a concurrency cap,
 * with schema validation (schema.ts), per-call timeouts, and git worktree isolation (worktree.ts).
 * Does not import pi packages at runtime, so tests can load it with a fake runner and fake git ops.
 */

import * as os from "node:os";
import * as path from "node:path";
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
import { extractJson, MAX_SCHEMA_RETRIES, schemaInstruction, schemaRetrySuffix, validateAgainst } from "./schema.ts";
import * as worktree from "./worktree.ts";
import type { ApplyPatchResult, IsolatedWorktree } from "./worktree.ts";

export { WORKFLOW_CHILD_EXCLUDED_TOOLS } from "./types.ts";

export type ChildRunner = (spec: RunSpec) => Promise<SingleResult>;

export type { ApplyPatchResult } from "./worktree.ts";

/** Git operations behind `isolation: "worktree"`; injectable for tests. */
export type WorktreeOps = Pick<
	typeof worktree,
	"getRepoRoot" | "createIsolatedWorktree" | "captureWorktreePatch" | "removeWorktree" | "sweepRunDir"
>;

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
	/** Overrides for the worktree git operations (default: worktree.ts). */
	worktrees?: Partial<WorktreeOps>;
	/** Overrides `applyPatch()` (default: all-or-nothing `git apply` on the checkout containing `cwd`). */
	applyPatch?: (patch: string) => Promise<ApplyPatchResult>;
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

export function composeWorkflowTask(prompt: string, agentNames: string[], schema?: object): string {
	return `${prompt}

<workflow-instructions>
${schema ? `${schemaInstruction(schema)}\n\n` : ""}You are one step of an automated workflow and cannot spawn agents yourself. If more delegated work is needed, end your response with a fenced code block tagged \`followups\` containing a JSON array of {"task": string, "agent": string} objects (agent must be one of: ${agentNames.join(", ")}). Omit the block when nothing is needed.
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

/** setTimeout's ceiling; larger delays would fire immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function errorLocation(stack: string | undefined): string | undefined {
	return stack?.match(/workflow\.js:\d+(?::\d+)?/)?.[0];
}

export function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowRunOutcome> {
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY));
	const piAgents = opts.agents.filter((a) => a.runner === "pi");
	const piAgentNames = piAgents.map((a) => a.name);
	const wtOps: WorktreeOps = {
		getRepoRoot: opts.worktrees?.getRepoRoot ?? worktree.getRepoRoot,
		createIsolatedWorktree: opts.worktrees?.createIsolatedWorktree ?? worktree.createIsolatedWorktree,
		captureWorktreePatch: opts.worktrees?.captureWorktreePatch ?? worktree.captureWorktreePatch,
		removeWorktree: opts.worktrees?.removeWorktree ?? worktree.removeWorktree,
		sweepRunDir: opts.worktrees?.sweepRunDir ?? worktree.sweepRunDir,
	};
	const runDir = path.join(os.tmpdir(), `pi-workflow-${opts.runId}`);
	let runDirUsed = false;
	let repoRootPromise: Promise<string | null> | undefined;
	/** Git toplevel of `cwd`, resolved on first use so workflows without isolation/applyPatch never run git. */
	const getRepoRoot = () => (repoRootPromise ??= wtOps.getRepoRoot(opts.cwd).catch(() => null));
	/** Serializes git operations that touch the user's checkout (worktree add/remove, stash create, apply). */
	let gitQueue: Promise<unknown> = Promise.resolve();
	const serialGit = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = gitQueue.then(fn, fn);
		gitQueue = next.catch(() => undefined);
		return next;
	};
	const applyPatchFn =
		opts.applyPatch ??
		(async (patch: string): Promise<ApplyPatchResult> => {
			const root = await getRepoRoot();
			if (!root) return { ok: false, error: "not a git repository" };
			return worktree.applyPatchToCheckout(root, patch);
		});

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
		const { schema, timeout, isolation } = call;
		if (schema !== undefined && (schema === null || typeof schema !== "object" || Array.isArray(schema))) {
			return failedResult(call, agentName, "error", "agent(): schema must be a JSON Schema object");
		}
		if (timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) {
			return failedResult(call, agentName, "error", "agent(): timeout must be a positive number of milliseconds");
		}
		if (isolation !== undefined && isolation !== "worktree") {
			return failedResult(call, agentName, "isolation", `agent(): unsupported isolation ${JSON.stringify(isolation)}; use "worktree"`);
		}
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
	 * Runs one `agent()` call inside its concurrency slot: optional worktree, then up to
	 * 1 + MAX_SCHEMA_RETRIES child attempts sharing one timeout budget, then the worktree patch.
	 * `onSpawn` fires before the first child process starts.
	 */
	const runCall = async (call: WorkflowAgentCall, row: WorkflowAgentRow, onSpawn: () => void): Promise<WorkflowAgentResult> => {
		const startedAt = Date.now();
		const usage = emptyUsage();
		const base = { agent: row.agent, label: call.label, phase: call.phase };
		const fail = (reason: WorkflowFailReason, error: string, extra?: Partial<WorkflowAgentResult>): WorkflowAgentResult => ({
			ok: false,
			...base,
			output: "",
			error,
			reason,
			followUps: [],
			attempts: row.attempts,
			usage,
			durationMs: Date.now() - startedAt,
			...extra,
		});

		const ctrl = new AbortController();
		const onRunAbort = () => ctrl.abort();
		runAbort.signal.addEventListener("abort", onRunAbort, { once: true });
		if (runAbort.signal.aborted) ctrl.abort();
		let timedOut = false;
		const timer =
			call.timeout !== undefined
				? setTimeout(
						() => {
							timedOut = true;
							ctrl.abort();
						},
						Math.min(call.timeout, MAX_TIMEOUT_MS),
					)
				: undefined;
		const stopped = (r?: SingleResult): { reason: WorkflowFailReason; error: string } =>
			timedOut
				? { reason: "timeout", error: `Timed out after ${call.timeout} ms` }
				: { reason: "aborted", error: r ? getResultOutput(r) : "Aborted" };

		let repoRoot: string | null = null;
		let wt: IsolatedWorktree | undefined;
		try {
			let cwd = opts.cwd;
			if (call.isolation === "worktree") {
				repoRoot = await getRepoRoot();
				if (!repoRoot) return fail("isolation", "isolation \"worktree\" needs a git repository; cwd is not inside one");
				const root = repoRoot;
				runDirUsed = true;
				try {
					wt = await serialGit(() => wtOps.createIsolatedWorktree(root, runDir, row.id));
				} catch (err) {
					return fail("isolation", `could not create worktree: ${errorMessage(err)}`);
				}
				cwd = worktree.worktreeCwd(root, wt.path, opts.cwd);
			}

			const schema = call.schema;
			const firstTask = composeWorkflowTask(call.prompt, piAgentNames, schema);
			let task = firstTask;
			let result: WorkflowAgentResult | undefined;
			for (let attempt = 0; !result; attempt++) {
				if (ctrl.signal.aborted) {
					result = fail(stopped().reason, stopped().error);
					break;
				}
				if (attempt === 0) onSpawn();
				const r = await runAttempt(row, { task, cwd, signal: ctrl.signal });
				addUsage(usage, r.usage);
				const raw = getFinalOutput(r.messages);
				const { output, followUps } = parseFollowUps(raw, piAgentNames);
				const ok = { ...base, output, followUps, model: r.model };
				if (isFailedResult(r)) {
					const why = r.stopReason === "aborted" ? stopped(r) : { reason: "error" as const, error: getResultOutput(r) };
					result = fail(why.reason, why.error, ok);
				} else if (!schema) {
					result = { ok: true, ...ok, attempts: row.attempts, usage, durationMs: Date.now() - startedAt };
				} else {
					const parsed = extractJson(output);
					const errors = "error" in parsed ? [parsed.error] : validateAgainst(schema, parsed.value);
					if (errors.length === 0 && "value" in parsed) {
						result = { ok: true, ...ok, data: parsed.value, attempts: row.attempts, usage, durationMs: Date.now() - startedAt };
					} else if (attempt >= MAX_SCHEMA_RETRIES) {
						result = fail("schema", errors.join("\n"), ok);
					} else {
						task = firstTask + schemaRetrySuffix(raw, errors);
					}
				}
			}

			if (wt && !runAbort.signal.aborted) {
				try {
					result.patch = await wtOps.captureWorktreePatch(wt);
				} catch (err) {
					const note = `patch capture failed: ${errorMessage(err)}`;
					result.error = result.error ? `${result.error}\n${note}` : note;
				}
			}
			result.attempts = row.attempts;
			result.durationMs = Date.now() - startedAt;
			return result;
		} finally {
			clearTimeout(timer);
			runAbort.signal.removeEventListener("abort", onRunAbort);
			if (wt && repoRoot) {
				const root = repoRoot;
				const wtPath = wt.path;
				await serialGit(() => wtOps.removeWorktree(root, wtPath));
			}
		}
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
			emitNow();
			value = await runCall(call, row, () => {
				details.spawned++;
				if (phase) phase.spawned++;
			});
		} catch (err) {
			value = failedResult(call, agentName, "error", errorMessage(err));
		} finally {
			sem.release();
		}
		settle(value);
	};

	/** All-or-nothing patch application; calls are serialized with the run's other checkout git operations. */
	const handleApplyPatch = async (id: number, params: { patch: unknown }): Promise<void> => {
		const patch = params?.patch;
		let value: ApplyPatchResult;
		if (typeof patch !== "string") value = { ok: false, error: "applyPatch(patch): patch must be a string" };
		else {
			try {
				value = await serialGit(() => applyPatchFn(patch));
			} catch (err) {
				value = { ok: false, error: errorMessage(err) };
			}
		}
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
		if (runDirUsed) {
			// Catches worktrees left behind by aborted or crashed calls.
			await gitQueue;
			const repoRoot = repoRootPromise ? await repoRootPromise : null;
			await wtOps.sweepRunDir(repoRoot, runDir).catch(() => undefined);
		}
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
