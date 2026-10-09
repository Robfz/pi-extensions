/** Shared types, constants, and pure helpers for the `spawn` tool. */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";

export type { AgentScope } from "./agents.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export const SUBAGENT_SPEND_CHANNEL = "subagent:spend";

/** Not "subagent": the pi-subagents package registers that name, and pi refuses to load duplicate tool names. */
export const TOOL_NAME = "spawn";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	durationMs?: number;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface LegacyDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type SubagentDetails = LegacyDetails | WorkflowDetails;

/** Default agent for workflow `agent()` calls that name none. */
export const DEFAULT_WORKFLOW_AGENT = "general";
export const DEFAULT_WORKFLOW_CONCURRENCY = 16;
/** Forced on every workflow child: children never spawn agents themselves. */
export const WORKFLOW_CHILD_EXCLUDED_TOOLS = [TOOL_NAME, "subagent"];

/** `agent()` call parameters sent from the worker to the host. */
export interface WorkflowAgentCall {
	prompt: string;
	/** Defaults to DEFAULT_WORKFLOW_AGENT. */
	agent?: string;
	/** JSON Schema the agent's output must validate against. */
	schema?: Record<string, unknown>;
	/** Milliseconds for the whole call. */
	timeout?: number;
	isolation?: "worktree";
	label?: string;
	/** Innermost active phase name, filled in by the worker. */
	phase?: string;
	/** Worker-assigned id of that phase (matches the `phase` messages). */
	phaseId?: number;
}

export type WorkflowFailReason = "error" | "timeout" | "aborted" | "schema" | "unknown-agent" | "isolation";

export interface WorkflowFollowUp {
	task: string;
	agent: string;
}

/** Value an `agent()` call resolves to inside the script; structured-clone safe. */
export interface WorkflowAgentResult {
	ok: boolean;
	agent: string;
	label?: string;
	phase?: string;
	/** Final assistant text with the followups block stripped. */
	output: string;
	/** Validated JSON when a schema was given. */
	data?: unknown;
	error?: string;
	reason?: WorkflowFailReason;
	followUps: WorkflowFollowUp[];
	/** Changes made in an isolated worktree. */
	patch?: string;
	/** Child processes run for this call (1 + schema retries). */
	attempts: number;
	/** Summed across attempts. */
	usage: UsageStats;
	model?: string;
	durationMs: number;
}

/** One per `agent()` call, for rendering. */
export interface WorkflowAgentRow {
	id: number;
	agent: string;
	label?: string;
	phase?: string;
	/** Index into WorkflowDetails.phases of the phase this call ran in. */
	phaseIndex?: number;
	status: "queued" | "running" | "done" | "failed";
	reason?: WorkflowFailReason;
	error?: string;
	startedAt?: number;
	endedAt?: number;
	attempts: number;
	cost: number;
	isolated?: boolean;
}

export interface WorkflowPhase {
	name: string;
	status: "running" | "done";
	startedAt: number;
	endedAt?: number;
	/** Calls in this phase that started running. */
	spawned: number;
	done: number;
	failed: number;
}

export type WorkflowStatus = "canceled" | "running" | "done" | "failed" | "aborted";

export interface WorkflowDetails {
	mode: "workflow";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	runId: string;
	/** Saved workflow name, or "inline". */
	name: string;
	source: "inline" | "user" | "project";
	script: string;
	args: unknown;
	status: WorkflowStatus;
	phases: WorkflowPhase[];
	agents: WorkflowAgentRow[];
	/** `agent()` calls that started running. */
	spawned: number;
	logs: string[];
	/** One entry per child process (attempt), `messages` dropped; spend tracking sums `usage.cost`. */
	results: SingleResult[];
	error?: string;
	startedAt: number;
	endedAt?: number;
}

/** Host → worker messages. */
export type HostToWorker =
	| { type: "response"; id: number; ok: true; value: unknown }
	| { type: "response"; id: number; ok: false; error: string };

/** Worker → host messages. */
export type WorkerToHost =
	| { type: "call"; id: number; method: "agent"; params: WorkflowAgentCall }
	| { type: "call"; id: number; method: "applyPatch"; params: { patch: string } }
	| { type: "log"; text: string }
	| { type: "phase"; id: number; name: string; event: "start" | "end" }
	/** `json` is the JSON text of the script's return value; absent when it returned undefined. */
	| { type: "done"; json?: string }
	| { type: "error"; message: string; stack?: string };

/** Published on `pi.events` channel "subagent:spend" (see SUBAGENT_SPEND_CHANNEL). */
export interface SubagentSpend {
	/** Cumulative subagent cost in USD: finished calls in the session file (all branches) + in-flight calls. */
	cost: number;
	/** True once any subagent call exists in the session, finished or in-flight. */
	hasRun: boolean;
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Sum of `results[].usage.cost` from a SubagentDetails-shaped value; 0 for anything else (e.g. `{}` from a thrown call). */
export function subagentCost(details: unknown): number {
	const results = (details as Partial<SubagentDetails> | undefined)?.results;
	if (!Array.isArray(results)) return 0;
	let cost = 0;
	for (const r of results) cost += r?.usage?.cost ?? 0;
	return cost;
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Caps model-facing text at PER_TASK_OUTPUT_CAP bytes; tool details keep the full output. */
export function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}
