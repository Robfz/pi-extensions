/**
 * status-bar extension
 *
 * Replaces pi's default footer entirely with a three-line layout (with a blank spacer):
 *
 *   Line 1:  <folder> <branch> <dirty-dot> <context-bar>
 *   Line 2:  (blank spacer)
 *   Line 3:  <model> • <effort>                                      <$cost [(sub)] pct%/win>
 *
 * Every line is padded with 1 column on the left and right.
 *
 * - folder      basename(cwd), colored `accent`
 * - branch      git --show-current, colored `success`; omitted when not in a repo
 * - dirty-dot   ●  green=clean, yellow=staged-only, red=unstaged/untracked
 *               omitted when not in a repo
 * - context-bar 5-cell █/░ bar, colored by pi's own thresholds (dim ≤70, warning >70, error >90)
 * - model       model.name with a leading "Claude " stripped (so "Claude Opus 4.7" → "Opus 4.7"),
 *               colored `accent`
 * - effort      thinking level when model.reasoning is true; colored using pi's matching
 *               `thinking{Level}` theme keys (so "high" glows the way pi glows it elsewhere)
 * - rest        only `$cost [(sub)] pct%/win`; the rest of pi's default stats (tokens, cache R/W)
 *               are intentionally dropped. The `(auto)` flag is also dropped because the extension
 *               API does not expose auto-compact state.
 *
 * Hooks: session_start + turn_end refresh the git dirty cache and request a re-render.
 *        Branch changes are picked up reactively via footerData.onBranchChange.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
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

/** Map a pi thinking level to its matching theme color. */
function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "dim";
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
				// 1-column left/right padding
				const innerWidth = Math.max(0, width - 2);
				const pad = (line: string, lineWidth: number): string => {
					// `lineWidth` is the visible width of `line`; left+right pad it to `width`.
					const gap = Math.max(0, width - lineWidth - 1);
					return ` ${line}${" ".repeat(gap)}`;
				};

				// -------- line 1: folder, branch, dirty dot, context bar
				const folder = basename(ctx.cwd) || ctx.cwd;
				const branch = footerData.getGitBranch();
				const ctxUsage = ctx.getContextUsage();
				const percent = ctxUsage?.percent ?? null;

				const line1Parts: string[] = [theme.fg("accent", folder)];
				if (branch) line1Parts.push(theme.fg("success", branch));
				const dot = dirtyDot(dirtyCache, theme);
				if (dot) line1Parts.push(dot);
				line1Parts.push(contextBar(percent, theme));
				const line1Truncated = truncateToWidth(line1Parts.join(" "), innerWidth, theme.fg("dim", "…"));
				const line1Padded = pad(line1Truncated, visibleWidth(line1Truncated));

				// -------- line 3 left: model • effort
				const model = ctx.model;
				const modelName = model ? shortModelName(model.name ?? model.id) : "no-model";
				let effort: string | null = null;
				if (model?.reasoning) {
					// pi's default footer reads state.thinkingLevel; extensions can read it by
					// scanning back for the latest thinking_level_change entry in the session.
					effort = "off";
					const entries = ctx.sessionManager.getEntries();
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e.type === "thinking_level_change") {
							effort = e.thinkingLevel;
							break;
						}
					}
				}
				const modelColored = theme.fg("accent", modelName);
				let left: string;
				let leftWidth: number;
				if (effort !== null) {
					const effortLabel = effort === "off" ? "thinking off" : effort;
					const effortColored = theme.fg(thinkingColor(effort), effortLabel);
					const sep = theme.fg("dim", " • ");
					left = modelColored + sep + effortColored;
					leftWidth = visibleWidth(modelName) + 3 + visibleWidth(effortLabel);
				} else {
					left = modelColored;
					leftWidth = visibleWidth(modelName);
				}

				// -------- line 3 right: $cost [(sub)] pct%/win
				let totalCost = 0;
				for (const e of ctx.sessionManager.getEntries()) {
					if (e.type === "message" && e.message.role === "assistant") {
						const m = e.message as AssistantMessage;
						totalCost += m.usage.cost.total;
					}
				}
				const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

				const statParts: string[] = [];
				if (totalCost || usingSubscription) {
					statParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}
				const window = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const pctStr =
					percent === null
						? `?/${formatTokens(window)}`
						: `${percent.toFixed(1)}%/${formatTokens(window)}`;
				statParts.push(pctStr);

				const rightRaw = statParts.join(" ");
				const rightWidth = visibleWidth(rightRaw);
				let rightColored: string;
				if (percent !== null && percent > 90) rightColored = theme.fg("error", rightRaw);
				else if (percent !== null && percent > 70) rightColored = theme.fg("warning", rightRaw);
				else rightColored = theme.fg("dim", rightRaw);

				// -------- assemble line 3 (left + gap + right) inside innerWidth
				let line3: string;
				let line3Width: number;
				if (leftWidth + 2 + rightWidth <= innerWidth) {
					const gap = " ".repeat(innerWidth - leftWidth - rightWidth);
					line3 = left + gap + rightColored;
					line3Width = innerWidth;
				} else {
					const room = Math.max(0, innerWidth - leftWidth - 2);
					const truncatedRight = truncateToWidth(rightColored, room, "");
					const truncatedRightWidth = visibleWidth(truncatedRight);
					const gap = " ".repeat(Math.max(0, innerWidth - leftWidth - truncatedRightWidth));
					line3 = left + gap + truncatedRight;
					line3Width = leftWidth + (innerWidth - leftWidth - truncatedRightWidth) + truncatedRightWidth;
				}
				const line3Padded = pad(line3, line3Width);

				return [line1Padded, "", line3Padded];
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
