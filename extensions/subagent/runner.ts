/**
 * Child-process runner for subagents: builds CLI args, spawns pi / cursor-agent,
 * and parses their JSON event streams into a SingleResult. No TUI imports.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { emptyUsage, getFinalOutput, type SingleResult } from "./types.ts";

export interface RunSpec {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	/** Raw task; the runner prefixes it with "Task: ". */
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	/** Receives the live in-progress result after every parsed event. */
	onUpdate?: (partial: SingleResult) => void;
	/** Tools excluded on top of the agent's own `excludedTools` (pi runner only). */
	extraExcludedTools?: string[];
	/** Resolves the pi command line; defaults to getPiInvocation. */
	piInvocation?: (args: string[]) => { command: string; args: string[] };
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/** Map cursor-agent tool names (from `<name>ToolCall` keys) to pi tool names for rendering. */
export const CURSOR_TOOL_NAME_MAP: Record<string, string> = {
	shell: "bash",
	glob: "find",
};

/**
 * Extract a tool name, args, and (for completed events) result from a
 * cursor-agent `tool_call` event payload. Payloads are either
 * `{ <name>ToolCall: { args: {...}, result?: {...} } }` or the generic
 * `{ function: { name, arguments: "<json>" } }` shape.
 */
export function parseCursorToolCall(toolCall: unknown): { name: string; args: Record<string, any>; result?: unknown } | null {
	if (!toolCall || typeof toolCall !== "object") return null;
	const record = toolCall as Record<string, any>;

	if (typeof record.function?.name === "string") {
		let args: Record<string, any> = {};
		try {
			const parsed = JSON.parse(record.function.arguments ?? "{}");
			if (parsed && typeof parsed === "object") args = parsed;
		} catch {
			/* ignore malformed arguments */
		}
		return { name: record.function.name, args };
	}

	const key = Object.keys(record).find((k) => k.endsWith("ToolCall"));
	if (!key) return null;
	const rawName = key.slice(0, -"ToolCall".length);
	const args = record[key]?.args;
	return {
		name: CURSOR_TOOL_NAME_MAP[rawName] ?? rawName,
		args: args && typeof args === "object" ? args : {},
		result: record[key]?.result,
	};
}

const CURSOR_TOOL_RESULT_CAP = 4000;

/**
 * Flatten a cursor tool result into display text. Results are keyed by status,
 * e.g. `{ success: {...} }`; any other status key is treated as an error.
 */
export function formatCursorToolResult(result: unknown): { text: string; isError: boolean } {
	if (!result || typeof result !== "object") return { text: "(no result)", isError: false };
	const record = result as Record<string, any>;
	const keys = Object.keys(record);
	if (keys.length === 0) return { text: "(no result)", isError: false };
	let statusKey: string;
	if ("success" in record) {
		statusKey = "success";
	} else {
		const errorKeys = ["error", "failure", "rejected", "cancelled", "denied"];
		const foundErrorKey = errorKeys.find((k) => k in record);
		if (foundErrorKey) {
			statusKey = foundErrorKey;
		} else {
			const objectKey = keys.find((k) => record[k] != null && typeof record[k] === "object");
			statusKey = objectKey ?? keys[0];
		}
	}
	const isError = statusKey !== "success";
	const payload = record[statusKey];
	let text: string;
	if (typeof payload === "string") {
		text = payload;
	} else if (payload && typeof payload === "object") {
		const preferred = payload.stdout ?? payload.output ?? payload.content;
		text = typeof preferred === "string" && preferred.trim() ? preferred : JSON.stringify(payload);
	} else {
		text = String(payload ?? statusKey);
	}
	if (text.length > CURSOR_TOOL_RESULT_CAP) text = `${text.slice(0, CURSOR_TOOL_RESULT_CAP)}\n[truncated]`;
	return { text: isError ? `[${statusKey}] ${text}` : text, isError };
}

/**
 * pi CLI args for an agent, excluding the system prompt and task. pi's `--exclude-tools`
 * is last-wins, so `extraExcludedTools` is merged with the agent's own list into one flag.
 */
export function buildPiArgs(agent: AgentConfig, extraExcludedTools: string[] = []): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	const excluded = [...new Set([...(agent.excludedTools ?? []), ...extraExcludedTools])];
	if (excluded.length > 0) args.push("--exclude-tools", excluded.join(","));
	return args;
}

/** cursor-agent CLI args for an agent, excluding the prompt. */
function buildCursorArgs(agent: AgentConfig): string[] {
	const args = ["-p", "--output-format", "stream-json", "--force", "--trust"];
	if (agent.model) args.push("--model", agent.model);
	// cursor-agent supports --mode plan/ask (CLI-enforced read-only); pi has no equivalent.
	// It has no tool allowlist/denylist flag: `tools:` is ignored and discovery rejects `excludedTools:`.
	if (agent.mode) args.push("--mode", agent.mode);
	return args;
}

export async function runSingleAgent(spec: RunSpec): Promise<SingleResult> {
	const { defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate } = spec;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			step,
		};
	}

	const isCursor = agent.runner === "cursor";
	const args = isCursor ? buildCursorArgs(agent) : buildPiArgs(agent, spec.extraExcludedTools);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	// Queued parallel tasks still reach here after an abort; don't start a child just to kill it.
	if (signal?.aborted) {
		currentResult.stopReason = "aborted";
		currentResult.errorMessage = "Subagent was aborted";
		return currentResult;
	}

	const emitUpdate = () => {
		onUpdate?.(currentResult);
	};

	try {
		if (isCursor) {
			// cursor-agent has no system prompt flag; embed the agent definition in the prompt.
			const systemPrompt = agent.systemPrompt.trim();
			args.push(
				systemPrompt
					? `<agent-instructions>\n${systemPrompt}\n</agent-instructions>\n\nTask: ${task}`
					: `Task: ${task}`,
			);
		} else {
			if (agent.systemPrompt.trim()) {
				const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}
			args.push(`Task: ${task}`);
		}
		let wasAborted = false;
		let sawTerminalResult = false;
		const startedAt = Date.now();

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = isCursor
				? { command: "cursor-agent", args }
				: (spec.piInvocation ?? getPiInvocation)(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			// `proc.killed` turns true once SIGTERM is sent, so track actual exit separately.
			let exited = false;
			let killTimer: NodeJS.Timeout | undefined;
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!exited) proc.kill("SIGKILL");
				}, 5000);
				killTimer.unref?.();
			};
			const markExited = () => {
				exited = true;
				clearTimeout(killTimer);
				signal?.removeEventListener("abort", killProc);
			};

			const processPiLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			// Builds pi-shaped assistant messages from cursor-agent NDJSON events
			// so the downstream pipeline (getFinalOutput, getDisplayItems, rendering) is shared.
			const makeExternalAssistantMessage = (content: Extract<Message, { role: "assistant" }>["content"]): Message => ({
				role: "assistant",
				content,
				api: "cursor-agent",
				provider: "cursor",
				model: currentResult.model ?? "unknown",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			let cursorToolCallCounter = 0;
			const pendingFallbackIds: string[] = [];
			const processCursorLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				switch (event.type) {
					case "system": {
						if (event.subtype === "init" && typeof event.model === "string" && event.model) {
							currentResult.model = event.model;
						}
						break;
					}
					case "assistant": {
						// One event per complete assistant message segment (between tool calls).
						const content = Array.isArray(event.message?.content) ? event.message.content : [];
						const text = content
							.filter((p: any) => p?.type === "text" && typeof p.text === "string")
							.map((p: any) => p.text)
							.join("");
						if (!text.trim()) break;
						currentResult.messages.push(makeExternalAssistantMessage([{ type: "text", text }]));
						currentResult.usage.turns++;
						emitUpdate();
						break;
					}
					case "tool_call": {
						const parsed = parseCursorToolCall(event.tool_call);
						if (!parsed) break;
						let id: string | undefined;
						if (typeof event.call_id === "string" && event.call_id) {
							id = event.call_id;
						} else if (event.subtype === "started") {
							id = `cursor-tool-${++cursorToolCallCounter}`;
							pendingFallbackIds.push(id);
						} else if (event.subtype === "completed") {
							id = pendingFallbackIds.shift();
							if (!id) break;
						} else {
							break;
						}
						if (!id) break;
						if (event.subtype === "started") {
							currentResult.messages.push(
								makeExternalAssistantMessage([{ type: "toolCall", id, name: parsed.name, arguments: parsed.args }]),
							);
							emitUpdate();
						} else if (event.subtype === "completed") {
							const { text, isError } = formatCursorToolResult(parsed.result);
							currentResult.messages.push({
								role: "toolResult",
								toolCallId: id,
								toolName: parsed.name,
								content: [{ type: "text", text }],
								isError,
								timestamp: Date.now(),
							});
							emitUpdate();
						}
						break;
					}
					case "result": {
						sawTerminalResult = true;
						if (event.usage && typeof event.usage === "object" && event.usage !== null) {
							const u = event.usage as Record<string, unknown>;
							if (typeof u.inputTokens === "number") currentResult.usage.input += u.inputTokens || 0;
							if (typeof u.outputTokens === "number") currentResult.usage.output += u.outputTokens || 0;
							if (typeof u.cacheReadTokens === "number") currentResult.usage.cacheRead += u.cacheReadTokens || 0;
							if (typeof u.cacheWriteTokens === "number") currentResult.usage.cacheWrite += u.cacheWriteTokens || 0;
						}
						if (event.is_error) {
							currentResult.stopReason = "error";
							if (typeof event.result === "string" && event.result.trim()) {
								currentResult.errorMessage = event.result;
							}
						} else {
							currentResult.stopReason = "stop";
							// Fallback: if no assistant text was streamed, use the aggregated result.
							if (
								!getFinalOutput(currentResult.messages) &&
								typeof event.result === "string" &&
								event.result.trim()
							) {
								currentResult.messages.push(makeExternalAssistantMessage([{ type: "text", text: event.result }]));
							}
						}
						emitUpdate();
						break;
					}
				}
			};

			const processLine = isCursor ? processCursorLine : processPiLine;

			proc.stdout?.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				markExited();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (err: NodeJS.ErrnoException) => {
				markExited();
				currentResult.stderr += `Failed to spawn "${invocation.command}": ${err.message}\n`;
				if (isCursor && err.code === "ENOENT") {
					currentResult.stderr += "Cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash\n";
				}
				resolve(1);
			});

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.durationMs = Date.now() - startedAt;
		if (isCursor && exitCode === 0 && !wasAborted && !sawTerminalResult) {
			currentResult.stopReason = "error";
			if (!currentResult.errorMessage) {
				currentResult.errorMessage = "cursor-agent exited without emitting a terminal result event";
			}
		}
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ??= "Subagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

