/**
 * Subagent Tool (`spawn`) - Delegate tasks to specialized agents
 *
 * Spawns a separate child process for each subagent invocation,
 * giving it an isolated context window. Agents run on one of two
 * runners (frontmatter `runner:`):
 *   - pi (default): `pi --mode json -p --no-session`
 *   - cursor: `cursor-agent -p --output-format stream-json --force --trust`
 *     (optional frontmatter `mode: plan|ask` maps to `--mode` for read-only runs)
 *
 * Supports four modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *   - Workflow: { workflow: "name" } or { script: "..." }, plus args?: {...}, runs an orchestration script
 *     (workflow.ts; saved scripts are found by saved-workflows.ts)
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Publishes cumulative subagent spend on `pi.events` (`subagent:spend`) for the status-bar extension.
 *
 * This file holds tool registration, spend tracking, approval, and mode dispatch; the child-process
 * runner lives in runner.ts, the workflow runtime in workflow.ts, TUI rendering in render.ts,
 * shared types/helpers in types.ts.
 */

import { randomBytes } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	approvalsPath,
	decideWorkflowGate,
	isAutoApproved,
	type ProjectAgentRef,
	projectKey,
	setAutoApproved,
} from "./approvals.ts";
import { renderCall, renderResult } from "./render.ts";
import { mapWithConcurrencyLimit, runSingleAgent } from "./runner.ts";
import { discoverWorkflows, resolveWorkflow } from "./saved-workflows.ts";
import {
	emptyUsage,
	errorMessage,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type LegacyDetails,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	type SingleResult,
	SUBAGENT_SPEND_CHANNEL,
	type SubagentSpend,
	subagentCost,
	TOOL_NAME,
	truncateOutput,
	type WorkflowDetails,
} from "./types.ts";
import { formatWorkflowResult, runWorkflow } from "./workflow.ts";

export type { SubagentSpend } from "./types.ts";

function runningText(result: SingleResult): string {
	return getFinalOutput(result.messages) || "(running...)";
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	script: Type.Optional(
		Type.String({
			description:
				"Inline workflow script: body of an async function using agent/parallel/pipeline/phase/log/args/applyPatch; must return plain data. See the `workflow` skill.",
		}),
	),
	workflow: Type.Optional(Type.String({ description: "Name of a saved workflow to run (workflow mode)" })),
	args: Type.Optional(
		Type.Record(Type.String(), Type.Any(), { description: "Arguments for the workflow script, available as `args`" }),
	),
});

type WorkflowApproval = { ok: true } | { ok: false; text: string; isError: boolean };

/** Applies decideWorkflowGate: may notify, show the run/view/auto-approve dialog, or refuse. */
async function approveWorkflow(
	ctx: ExtensionContext,
	opts: {
		name: string;
		source: WorkflowDetails["source"];
		/** Saved workflows only. */
		filePath?: string;
		script: string;
		agentCount: number;
		agentScope: AgentScope;
		agents: AgentConfig[];
		projectAgentsDir: string | null;
	},
): Promise<WorkflowApproval> {
	const key = projectKey(ctx.cwd);
	const projectAgents: ProjectAgentRef[] = [];
	if (opts.agentScope !== "user") {
		const userNames = new Set(discoverAgents(ctx.cwd, "user").agents.map((a) => a.name));
		for (const a of opts.agents) {
			if (a.source === "project") projectAgents.push({ name: a.name, overridesUser: userNames.has(a.name) });
		}
	}
	const decision = decideWorkflowGate({
		name: opts.name,
		hasUI: ctx.hasUI,
		autoApproved: isAutoApproved(key),
		source: opts.source,
		agentScope: opts.agentScope,
		projectAgents,
		projectAgentsDir: opts.projectAgentsDir,
	});
	switch (decision.action) {
		case "run":
			return { ok: true };
		case "notify":
			ctx.ui.notify(decision.message, "info");
			return { ok: true };
		case "refuse":
			return {
				ok: false,
				isError: true,
				text: `${decision.message}\n(Auto-approvals live in ${approvalsPath()}.)`,
			};
	}
	const lines = opts.script.split("\n").length;
	const from = opts.filePath ? ` from ${opts.filePath}` : "";
	const title =
		`Run workflow "${opts.name}"${from}? (${lines} lines, ${opts.agentCount} agents available, scope ${opts.agentScope})` +
		(decision.projectAgentsNote ? `\n${decision.projectAgentsNote}\nOnly continue for trusted repositories.` : "");
	const RUN = "Run";
	const VIEW = "View script";
	const AUTO = "Auto-approve for this project and run";
	const CANCEL = "Cancel";
	while (true) {
		const choice = await ctx.ui.select(title, [RUN, VIEW, AUTO, CANCEL]);
		if (choice === RUN) return { ok: true };
		if (choice === VIEW) {
			await ctx.ui.editor(`Workflow "${opts.name}" — view only, edits are ignored`, opts.script);
			continue;
		}
		if (choice === AUTO) {
			await setAutoApproved(key);
			return { ok: true };
		}
		return { ok: false, isError: false, text: "Canceled: workflow not approved." };
	}
}

function workflowProgressText(d: WorkflowDetails): string {
	const running = d.agents.filter((a) => a.status === "running").length;
	const done = d.agents.filter((a) => a.status === "done").length;
	const failed = d.agents.filter((a) => a.status === "failed").length;
	return `Workflow "${d.name}": ${done} done, ${failed} failed, ${running} running, $${subagentCost(d).toFixed(4)}`;
}

export default function (pi: ExtensionAPI) {
	// Advertise user-scope agents and saved workflows in the tool description so the model knows what
	// exists without a failed probe call. Discovered once at registration; execute() re-discovers.
	const startupAgents = discoverAgents(process.cwd(), "user").agents;
	const startupWorkflows = discoverWorkflows(process.cwd(), "user");

	// Subagent spend: finished calls (persisted as toolResult entries) + latest cumulative cost per in-flight call.
	let committedCost = 0;
	let hasCommitted = false;
	const inFlight = new Map<string, number>();
	const emitSpend = () => {
		let cost = committedCost;
		for (const c of inFlight.values()) cost += c;
		const payload: SubagentSpend = { cost, hasRun: hasCommitted || inFlight.size > 0 };
		pi.events.emit(SUBAGENT_SPEND_CHANNEL, payload);
	};

	pi.on("session_start", (_event, ctx) => {
		committedCost = 0;
		hasCommitted = false;
		inFlight.clear();
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type !== "message" || e.message.role !== "toolResult" || e.message.toolName !== TOOL_NAME) continue;
			hasCommitted = true;
			committedCost += subagentCost(e.message.details);
		}
		emitSpend();
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== TOOL_NAME) return;
		inFlight.set(event.toolCallId, 0);
		emitSpend();
	});

	pi.on("tool_execution_update", (event) => {
		if (event.toolName !== TOOL_NAME) return;
		inFlight.set(event.toolCallId, subagentCost(event.partialResult?.details));
		emitSpend();
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== TOOL_NAME) return;
		inFlight.delete(event.toolCallId);
		committedCost += subagentCost(event.result?.details);
		hasCommitted = true;
		emitSpend();
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder),",
			"workflow ({workflow: name, args} runs a saved JS orchestration script, {script, args} an inline one; load the workflow skill before writing a script).",
			'Default agent scope is "user" (agents from ~/.pi/agent/agents, workflows from ~/.pi/agent/workflows).',
			'To enable project-local agents in .pi/agents and workflows in .pi/workflows, set agentScope: "both" (or "project").',
			...(startupAgents.length > 0
				? [`Available user agents: ${startupAgents.map((a) => `${a.name} — ${a.description}`).join("; ")}.`]
				: []),
			...(startupWorkflows.length > 0
				? [
						`Saved user workflows: ${startupWorkflows.map((w) => (w.description ? `${w.name} — ${w.description}` : w.name)).join("; ")}`,
					]
				: []),
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasWorkflow = Boolean(params.script) || Boolean(params.workflow);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasWorkflow);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): LegacyDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (hasWorkflow) {
				if (params.workflow && params.script) {
					return {
						content: [
							{ type: "text", text: "Invalid parameters. Pass either `workflow` (saved) or `script` (inline), not both." },
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const saved = params.workflow ? resolveWorkflow(ctx.cwd, params.workflow, agentScope) : null;
				if (params.workflow && !saved) {
					const available = discoverWorkflows(ctx.cwd, agentScope).map((w) => `${w.name} (${w.source})`);
					// Project workflows are opt-in like project agents; say so when the name exists there.
					const hidden = agentScope === "user" ? resolveWorkflow(ctx.cwd, params.workflow, "project") : null;
					return {
						content: [
							{
								type: "text",
								text:
									`Unknown workflow "${params.workflow}" (scope ${agentScope}). Available workflows: ${available.join(", ") || "none"}.` +
									(hidden ? ` A project workflow exists at ${hidden.filePath}; pass agentScope: "both" to use it.` : ""),
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const script = saved ? saved.script : (params.script ?? "");
				const name = saved ? saved.name : "inline";
				const source: WorkflowDetails["source"] = saved ? saved.source : "inline";
				const runId = `wf-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
				const baseDetails = (status: WorkflowDetails["status"]): WorkflowDetails => ({
					mode: "workflow",
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					runId,
					name,
					source,
					script,
					args: params.args ?? {},
					status,
					phases: [],
					agents: [],
					spawned: 0,
					logs: [],
					results: [],
					startedAt: Date.now(),
				});

				const approval = await approveWorkflow(ctx, {
					name,
					source,
					filePath: saved?.filePath,
					script,
					agentCount: agents.filter((a) => a.runner === "pi").length,
					agentScope,
					agents,
					projectAgentsDir: discovery.projectAgentsDir,
				});
				if (!approval.ok) {
					return {
						content: [{ type: "text", text: approval.text }],
						details: baseDetails("canceled"),
						isError: approval.isError,
					};
				}

				const outcome = await runWorkflow({
					runId,
					name,
					source,
					script,
					args: params.args ?? {},
					cwd: ctx.cwd,
					agents,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					signal,
					runner: runSingleAgent,
					onProgress: onUpdate
						? (d) => onUpdate({ content: [{ type: "text", text: workflowProgressText(d) }], details: d })
						: undefined,
				});
				const d = outcome.details;
				// Never throw from here: a thrown execute loses `details` and with it the run's spend.
				try {
					const cost = subagentCost(d).toFixed(4);
					if (d.status === "done") {
						return {
							content: [
								{
									type: "text",
									text: `Workflow "${name}" finished: ${d.spawned} agents, $${cost}\n\n${formatWorkflowResult(outcome.result)}`,
								},
							],
							details: d,
						};
					}
					if (d.status === "aborted") {
						return {
							content: [{ type: "text", text: `Workflow aborted after ${d.spawned} agents ($${cost})` }],
							details: d,
							isError: true,
						};
					}
					const logTail = d.logs.slice(-20);
					return {
						content: [
							{
								type: "text",
								text:
									`Workflow "${name}" failed: ${d.error ?? "unknown error"}` +
									(logTail.length > 0 ? `\n\nLast logs:\n${logTail.join("\n")}` : ""),
							},
						],
						details: d,
						isError: true,
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Workflow "${name}" ended (${d.status}) but its result could not be formatted: ${errorMessage(err)}` }],
						details: d,
						isError: true,
					};
				}
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: step.agent,
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						signal,
						// Combine completed steps with the current streaming step
						onUpdate: onUpdate
							? (current) =>
									onUpdate({
										content: [{ type: "text", text: runningText(current) }],
										details: makeDetails("chain")([...results, current]),
									})
							: undefined,
					});
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = truncateOutput(getResultOutput(result));
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text: truncateOutput(getFinalOutput(results[results.length - 1].messages) || "(no output)"),
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: t.agent,
						task: t.task,
						cwd: t.cwd,
						signal,
						onUpdate: (current) => {
							allResults[index] = current;
							emitParallelUpdate();
						},
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "stop" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents,
					agentName: params.agent,
					task: params.task,
					cwd: params.cwd,
					signal,
					onUpdate: onUpdate
						? (current) =>
								onUpdate({
									content: [{ type: "text", text: runningText(current) }],
									details: makeDetails("single")([current]),
								})
						: undefined,
				});
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = truncateOutput(getResultOutput(result));
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(result.messages) || "(no output)") }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			return renderCall(args, theme);
		},

		renderResult(result, options, theme, _context) {
			return renderResult(result, options, theme);
		},
	});
}
