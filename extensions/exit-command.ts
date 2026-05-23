/**
 * exit-command extension
 *
 * Two flavors of "exit" depending on how much patience you have:
 *
 *   - `.exit` / `.q`  — *immediate*. The input is consumed (`action: "handled"`),
 *     never reaches the agent, and `ctx.shutdown()` is called right away.
 *     Use when you just want out.
 *
 *   - `exit`           — *deferred*. The input passes through unchanged
 *     (`action: "continue"`) so the agent can still reply and run tools, and
 *     `ctx.shutdown()` is called from `agent_end` once the whole loop wraps up.
 *     Use when you want to give the agent a chance to acknowledge / finish a
 *     last bit of work first.
 *
 * `agent_end` is used for the deferred case (rather than `turn_end`) because a
 * single user message can span multiple turns when the agent calls tools; we
 * want to exit only when the agent has fully wrapped up.
 *
 * All matches are case-insensitive and require the message to be *only* the
 * trigger token (after trimming), so legitimate prompts like "exit the function
 * early" still go through normally.
 *
 * Only `source: "interactive"` inputs are considered, so RPC or extension-sent
 * inputs containing a trigger can't accidentally tear down the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const IMMEDIATE_PATTERN = /^\.(exit|q)$/i;
const DEFERRED_PATTERN = /^exit$/i;

let shutdownPending = false;

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx: ExtensionContext) => {
		if (event.source !== "interactive") return { action: "continue" as const };

		const text = event.text.trim();

		if (IMMEDIATE_PATTERN.test(text)) {
			ctx.shutdown();
			return { action: "handled" as const };
		}

		if (DEFERRED_PATTERN.test(text)) {
			shutdownPending = true;
			if (ctx.hasUI) {
				ctx.ui.notify("Exit requested — pi will quit when the agent finishes.", "info");
			}
			return { action: "continue" as const };
		}

		return { action: "continue" as const };
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (!shutdownPending) return;
		shutdownPending = false;
		ctx.shutdown();
	});
}
