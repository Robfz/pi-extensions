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
 *     `ctx.shutdown()` is called from `agent_end` once *that exit's own agent
 *     loop* wraps up. Use when you want to give the agent a chance to
 *     acknowledge / finish a last bit of work first.
 *
 * Why we arm at `before_agent_start`, not at `input`:
 *
 * Inputs can be submitted while a previous agent loop is still streaming; pi
 * queues them and starts a fresh agent loop afterwards. If we flipped a
 * "shutdownPending" flag in the `input` hook, the *previous* loop's `agent_end`
 * would fire first and shut pi down before the queued `exit` ever reached the
 * agent — defeating the whole point of the deferred path.
 *
 * Instead, the `input` hook just records that an interactive `exit` was
 * requested (the "intent" flag). When pi starts a new agent loop, the
 * `before_agent_start` event hands us the actual `prompt` for that loop; if it
 * matches the deferred trigger and the intent flag is set, we arm shutdown for
 * *that* loop. The matching `agent_end` is guaranteed to belong to the same
 * loop, so there's no race.
 *
 * The two flags serve different purposes:
 *
 *   - `interactiveExitRequested`  — gate: only an interactive `exit` should
 *     ever shut pi down. Keeps the original guarantee that RPC or
 *     extension-sent inputs containing the literal string "exit" can't
 *     accidentally tear down the session.
 *   - `shutdownThisAgent`          — scope: shutdown fires only on the
 *     `agent_end` that pairs with the `before_agent_start` we armed on, never
 *     on an earlier in-flight loop.
 *
 * All triggers are case-insensitive and must be the *entire* message after
 * trimming, so legitimate prompts like "exit the function early" go through
 * unchanged.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const IMMEDIATE_PATTERN = /^\.(exit|q)$/i;
const DEFERRED_PATTERN = /^exit$/i;

let interactiveExitRequested = false;
let shutdownThisAgent = false;

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx: ExtensionContext) => {
		if (event.source !== "interactive") return { action: "continue" as const };

		const text = event.text.trim();

		if (IMMEDIATE_PATTERN.test(text)) {
			ctx.shutdown();
			return { action: "handled" as const };
		}

		if (DEFERRED_PATTERN.test(text)) {
			interactiveExitRequested = true;
			if (ctx.hasUI) {
				ctx.ui.notify("Exit requested — pi will quit when the agent finishes.", "info");
			}
		}

		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event) => {
		if (!interactiveExitRequested) return;
		if (!DEFERRED_PATTERN.test(event.prompt.trim())) return;

		// This is the agent loop spawned by the interactive `exit` prompt;
		// arm shutdown for its matching agent_end and clear the intent.
		interactiveExitRequested = false;
		shutdownThisAgent = true;
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (!shutdownThisAgent) return;
		shutdownThisAgent = false;
		ctx.shutdown();
	});
}
