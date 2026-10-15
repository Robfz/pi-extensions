/**
 * auto-name extension
 *
 * Names the session after its first completed agent run, using a cheap model
 * to summarize the opening exchange into a short title. The name shows in the
 * session selector and the terminal title.
 *
 * Triggers on `agent_settled` (not `turn_end`) so the whole first run —
 * including tool loops, retries, and compaction — has finished and the naming
 * request never competes with the main run.
 *
 * Skips when the session already has a name (`/name`, `--name`, a previous
 * auto-name), so it runs at most once per session and never overrides a
 * user-chosen name. Aborted runs are skipped; the next completed run retries.
 *
 * Fails silently: any error leaves the session unnamed.
 */

import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NAMING_PROVIDER = "anthropic";
const NAMING_MODEL = "claude-haiku-5-5";
const MAX_INPUT_CHARS = 2000;
const MAX_NAME_CHARS = 60;

const SYSTEM_PROMPT = `You title coding-assistant conversations.
Reply with only a 3-6 word title describing the user's task. No quotes, no trailing punctuation, no preamble.`;

type ContentBlock = { type: string; text?: string };

function textOf(content: string | ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n");
}

/** First user prompt and first non-empty assistant reply on the current branch. */
function openingExchange(ctx: ExtensionContext): { user: string; assistant: string } | undefined {
	let user = "";
	let assistant = "";
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const { role, content } = entry.message as { role: string; content: string | ContentBlock[] };
		if (role === "user" && !user) user = textOf(content).trim();
		else if (role === "assistant" && user && !assistant) assistant = textOf(content).trim();
		if (user && assistant) break;
	}
	if (!user) return undefined;
	return { user: user.slice(0, MAX_INPUT_CHARS), assistant: assistant.slice(0, MAX_INPUT_CHARS) };
}

function sanitize(raw: string): string {
	const line = raw.trim().split("\n")[0] ?? "";
	return line
		.replace(/^["'`*#\s]+|["'`*.\s]+$/g, "")
		.slice(0, MAX_NAME_CHARS)
		.trim();
}

export default function (pi: ExtensionAPI) {
	let inFlight: AbortController | undefined;

	async function generateName(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
		const exchange = openingExchange(ctx);
		if (!exchange) return undefined;

		const preferred = ctx.modelRegistry.find(NAMING_PROVIDER, NAMING_MODEL);
		const model = preferred && ctx.modelRegistry.hasConfiguredAuth(preferred) ? preferred : ctx.model;
		if (!model) return undefined;

		const message: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `<user>\n${exchange.user}\n</user>\n\n<assistant>\n${exchange.assistant}\n</assistant>`,
				},
			],
			timestamp: Date.now(),
		};

		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
			{ signal, cacheRetention: "none", sessionId: uuidv7() },
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;

		return sanitize(textOf(response.content as ContentBlock[])) || undefined;
	}

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || inFlight || pi.getSessionName()) return;

		const controller = new AbortController();
		inFlight = controller;
		generateName(ctx, controller.signal)
			.then((name) => {
				// Re-check: the user may have run /name while we were generating.
				if (name && !controller.signal.aborted && !pi.getSessionName()) pi.setSessionName(name);
			})
			.catch(() => {})
			.finally(() => {
				if (inFlight === controller) inFlight = undefined;
			});
	});

	pi.on("session_shutdown", () => {
		inFlight?.abort();
		inFlight = undefined;
	});
}
