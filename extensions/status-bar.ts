/**
 * status-bar extension
 *
 * Replaces pi's default footer entirely with a two-line layout:
 *
 *   Line 1:  <folder> <branch> <dirty-dot> <context-bar>
 *   Line 2:  <model-short> • <effort>           <↑in ↓out Rread Wwrite $cost pct%/win (sub)?>
 *
 * - folder      basename(cwd)
 * - branch      git --show-current, or omitted when not in a repo
 * - dirty-dot   ●  green=clean, yellow=staged-only, red=unstaged/untracked
 *               omitted when not in a repo
 * - context-bar 5-cell █/░ bar, colored by pi's own thresholds (dim ≤70, warning >70, error >90)
 * - model-short model.name with a leading "Claude " stripped (so "Claude Opus 4.7" → "Opus 4.7")
 * - effort      thinking level when model.reasoning is true; "thinking off" when level is "off"
 * - rest        token / cache / cost / context-% identical to pi's default, including " (sub)"
 *               when authed via OAuth. The "(auto)" auto-compact flag is dropped because the
 *               extension API does not expose that state.
 *
 * Hooks: session_start + turn_end refresh the git dirty cache and request a re-render.
 *        Branch changes are picked up reactively via footerData.onBranchChange.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ---------- git dirty status ---------------------------------------------------------------

type Dirty = "clean" | "staged" | "dirty" | "none";

/** Cached so render() stays synchronous. Refreshed on session_start, turn_end, branch change. */
let dirtyCache: Dirty = "none";

async function refreshDirty(cwd: string): Promise<Dirty> {
	try {
		const { stdout } = await exec("git", ["-C", cwd, "status", "--porcelain"], { timeout: 800 });
		if (!stdout.trim()) return "clean";

		let hasUnstaged = false;
		let hasStaged = false;
		for (const line of stdout.split("\n")) {
			if (!line) continue;
			const x = line[0];
			const y = line[1];
			if (x === "?" && y === "?") {
				hasUnstaged = true;
			} else {
				if (x !== " " && x !== "?") hasStaged = true;
				if (y !== " ") hasUnstaged = true;
			}
		}
		return hasUnstaged ? "dirty" : hasStaged ? "staged" : "clean";
	} catch {
		return "none"; // not a repo, git missing, or timeout
	}
}

// ---------- presentation helpers -----------------------------------------------------------

const LAB_PREFIXES = ["Claude "];
function shortModelName(name: string): string {
	for (const p of LAB_PREFIXES) {
		if (name.startsWith(p)) return name.slice(p.length);
	}
	return name;
}

/** Mirror pi's own token formatting: 999 → "999", 1500 → "1.5k", 1_500_000 → "1.5M". */
function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function contextBar(percent: number | null, theme: Theme): string {
	const cells = 5;
	if (percent == null) {
		return theme.fg("dim", "·····");
	}
	const filled = Math.min(cells, Math.max(0, Math.round(percent / (100 / cells))));
	const bar = "█".repeat(filled) + "░".repeat(cells - filled);
	if (percent > 90) return theme.fg("error", bar);
	if (percent > 70) return theme.fg("warning", bar);
	return theme.fg("dim", bar);
}

function dirtyDot(state: Dirty, theme: Theme): string {
	switch (state) {
		case "clean":
			return theme.fg("success", "●");
		case "staged":
			return theme.fg("warning", "●");
		case "dirty":
			return theme.fg("error", "●");
		case "none":
			return "";
	}
}

// ---------- footer installation ------------------------------------------------------------

/** Holds the active TUI so out-of-band events (session_start, turn_end) can request renders. */
let tuiRef: { requestRender(): void } | null = null;

function installFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		tuiRef = tui;

		const unsubBranch = footerData.onBranchChange(() => {
			void refreshDirty(ctx.cwd).then((d) => {
				dirtyCache = d;
				tui.requestRender();
			});
		});

		return {
			invalidate() {},
			dispose: () => {
				if (tuiRef === tui) tuiRef = null;
				unsubBranch();
			},
			render(width: number): string[] {
				// -------- line 1: folder, branch, dirty dot, context bar
				const folder = basename(ctx.cwd) || ctx.cwd;
				const branch = footerData.getGitBranch();
				const ctxUsage = ctx.getContextUsage();
				const percent = ctxUsage?.percent ?? null;

				const line1Parts: string[] = [theme.fg("text", folder)];
				if (branch) line1Parts.push(theme.fg("dim", branch));
				const dot = dirtyDot(dirtyCache, theme);
				if (dot) line1Parts.push(dot);
				line1Parts.push(contextBar(percent, theme));
				const line1 = line1Parts.join(" ");

				// -------- line 2 left: model • effort
				const model = ctx.model;
				const modelName = model ? shortModelName(model.name ?? model.id) : "no-model";
				let leftRaw = modelName;
				if (model?.reasoning) {
					// pi's default footer reads state.thinkingLevel; extensions can read it by
					// scanning back for the latest thinking_level_change entry in the session.
					let effort = "off";
					const entries = ctx.sessionManager.getEntries();
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e.type === "thinking_level_change") {
							effort = e.thinkingLevel;
							break;
						}
					}
					leftRaw = effort === "off" ? `${modelName} • thinking off` : `${modelName} • ${effort}`;
				}
				const left = theme.fg("dim", leftRaw);

				// -------- line 2 right: ↑in ↓out Rread Wwrite $cost pct%/win [(sub)]
				let totalInput = 0;
				let totalOutput = 0;
				let totalCacheRead = 0;
				let totalCacheWrite = 0;
				let totalCost = 0;
				for (const e of ctx.sessionManager.getEntries()) {
					if (e.type === "message" && e.message.role === "assistant") {
						const m = e.message as AssistantMessage;
						totalInput += m.usage.input;
						totalOutput += m.usage.output;
						totalCacheRead += m.usage.cacheRead;
						totalCacheWrite += m.usage.cacheWrite;
						totalCost += m.usage.cost.total;
					}
				}

				const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

				const statParts: string[] = [];
				if (totalInput) statParts.push(`↑${formatTokens(totalInput)}`);
				if (totalOutput) statParts.push(`↓${formatTokens(totalOutput)}`);
				if (totalCacheRead) statParts.push(`R${formatTokens(totalCacheRead)}`);
				if (totalCacheWrite) statParts.push(`W${formatTokens(totalCacheWrite)}`);
				if (totalCost || usingSubscription) {
					statParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}

				const window = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const pctStr =
					percent === null
						? `?/${formatTokens(window)}`
						: `${percent.toFixed(1)}%/${formatTokens(window)}`;
				let pctColored = pctStr;
				if (percent !== null && percent > 90) pctColored = theme.fg("error", pctStr);
				else if (percent !== null && percent > 70) pctColored = theme.fg("warning", pctStr);
				statParts.push(pctColored);

				const rightRaw = statParts.join(" ");
				const right = theme.fg("dim", rightRaw);

				// -------- assemble & pad line 2
				const leftW = visibleWidth(left);
				const rightW = visibleWidth(right);
				let line2: string;
				if (leftW + 2 + rightW <= width) {
					const pad = " ".repeat(width - leftW - rightW);
					line2 = left + pad + right;
				} else {
					// truncate right side to fit; keep left as-is
					const room = Math.max(0, width - leftW - 2);
					const truncated = truncateToWidth(right, room, "");
					const pad = " ".repeat(Math.max(0, width - leftW - visibleWidth(truncated)));
					line2 = left + pad + truncated;
				}

				return [truncateToWidth(line1, width, theme.fg("dim", "…")), line2];
			},
		};
	});
}

// ---------- entry --------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		dirtyCache = await refreshDirty(ctx.cwd);
		tuiRef?.requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		dirtyCache = await refreshDirty(ctx.cwd);
		tuiRef?.requestRender();
	});
}
