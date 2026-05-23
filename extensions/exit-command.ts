/**
 * exit-command extension
 *
 * Makes the dot-prefixed triggers `.exit` and `.q` actually shut pi down — but
 * only after the agent has finished responding to that message. The flow is:
 *
 *   1. User types `.exit` (or `.q`). The `input` event fires.
 *   2. We flag the session as "shutdown pending" and let the input pass through
 *      unchanged (`action: "continue"`), so the agent still receives it and can
 *      reply, run tools, do whatever it wants.
 *   3. When the whole agent loop ends (`agent_end`), we call `ctx.shutdown()`.
 *
 * `agent_end` is used instead of `turn_end` because a single user message can
 * span multiple turns when the agent calls tools; we want to exit only when the
 * agent has fully wrapped up.
 *
 * The match is case-insensitive but requires the message to be *only* `.exit`
 * or `.q` (after trimming), so legitimate prompts that mention those tokens
 * inline still go through normally. The dot prefix also means we won't trip on
 * bare `exit` / `quit` that a user might want the agent to interpret literally.
 *
 * Only `source: "interactive"` inputs are considered, so RPC or extension-sent
 * inputs containing the trigger can't accidentally tear down the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXIT_PATTERN = /^\.(exit|q)$/i;

let shutdownPending = false;

function isExitInput(text: string): boolean {
	return EXIT_PATTERN.test(text.trim());
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx: ExtensionContext) => {
		if (event.source !== "interactive") return { action: "continue" as const };
		if (!isExitInput(event.text)) return { action: "continue" as const };

		shutdownPending = true;

		if (ctx.hasUI) {
			ctx.ui.notify("Exit requested — pi will quit when the agent finishes.", "info");
		}

		return { action: "continue" as const };
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (!shutdownPending) return;
		shutdownPending = false;
		ctx.shutdown();
	});
}
