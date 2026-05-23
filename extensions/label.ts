/**
 * /label and /unlabel slash commands.
 *
 * Label the most recent assistant message without entering /tree.
 * Labels persist in the session JSONL and show up in the /tree filter for
 * "labeled only" entries (default ctrl+L there).
 *
 * Adapted from the upstream `bookmark.ts` example, renamed to match pi's
 * own vocabulary ("label" rather than "bookmark"). See:
 *   ~/.asdf/.../@earendil-works/pi-coding-agent/examples/extensions/bookmark.ts
 *   docs/extensions.md → pi.setLabel
 *
 * Usage:
 *   /label              → labels the last assistant message as `label-<ts>`
 *   /label <name>       → labels it as <name>
 *   /unlabel            → clears the label from the most recently labeled entry
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("label", {
		description: "Label last assistant message (usage: /label [name])",
		handler: async (args, ctx) => {
			const label = args.trim() || `label-${Date.now()}`;

			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					pi.setLabel(entry.id, label);
					ctx.ui.notify(`Labeled as: ${label}`, "info");
					return;
				}
			}

			ctx.ui.notify("No assistant message to label", "warning");
		},
	});

	pi.registerCommand("unlabel", {
		description: "Remove label from the most recently labeled entry",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				const label = ctx.sessionManager.getLabel(entry.id);
				if (label) {
					pi.setLabel(entry.id, undefined);
					ctx.ui.notify(`Removed label: ${label}`, "info");
					return;
				}
			}
			ctx.ui.notify("No labeled entry found", "warning");
		},
	});
}
