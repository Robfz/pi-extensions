/**
 * dump-prompt extension
 *
 * Registers a `/dump-prompt` slash command that writes the current effective
 * system prompt (from `ctx.getSystemPrompt()`) to a stable temp-file path and
 * reports its size via `ctx.ui.notify`. Intended for inspecting what pi
 * actually sends as the system prompt in the current session \u2014 useful when
 * planning customizations, since the assembled prompt includes tool snippets,
 * extension-supplied guidelines, project context files, and skills.
 *
 * Output:
 *   path:    /tmp/pi-system-prompt.md  (overwritten each invocation)
 *   notify:  "System prompt: <chars> chars, <lines> lines, ~<tokens> tokens"
 *
 * Token estimate is the classic chars/4 heuristic \u2014 fine for a size check,
 * not for billing.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DUMP_PATH = join(tmpdir(), "pi-system-prompt.md");

export default function (pi: ExtensionAPI) {
	pi.registerCommand("dump-prompt", {
		description: "Dump the current effective system prompt to /tmp/pi-system-prompt.md and report its size.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const prompt = ctx.getSystemPrompt();

			try {
				await writeFile(DUMP_PATH, prompt, "utf8");
			} catch (err) {
				ctx.ui.notify(`Failed to write ${DUMP_PATH}: ${(err as Error).message}`, "error");
				return;
			}

			const chars = prompt.length;
			const lines = prompt.split("\n").length;
			const tokensApprox = Math.round(chars / 4);

			ctx.ui.notify(
				`System prompt: ${chars} chars · ${lines} lines · ~${tokensApprox} tokens (chars/4)\n${DUMP_PATH}`,
				"info",
			);
		},
	});
}
