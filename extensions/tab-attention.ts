/**
 * tab-attention extension
 *
 * Prepends "● " to the terminal title when an agent loop finishes, and
 * clears it as soon as the user starts typing the next prompt. In
 * terminals that show the title per-tab (Ghostty, iTerm2, kitty, WezTerm,
 * …), this lets you tell at a glance which Pi tab is waiting on you,
 * without clicking through every tab.
 *
 *   idle:        π - <session> - <cwd>          (or "π - <cwd>" when unnamed)
 *   needs-you:   ● π - <session> - <cwd>
 *
 * No terminal config required. Unlike BEL-based approaches (Ghostty's
 * `bell-features = title` injects 🔔), this writes the title directly via
 * pi's UI API, so we control the character and the timing.
 *
 * Trade-off vs. the previous BEL approach: no Dock bounce / urgency hint
 * (those rode on Ghostty's `attention` bell-feature). Purely a visual
 * title indicator now.
 *
 * Why `agent_end` (not `turn_end`):
 *   Pi fires `turn_end` once per LLM call *inside* an agent loop, so a
 *   single user prompt that triggers N tool calls would flash N times.
 *   `agent_end` fires once the agent stops asking for tools and control
 *   returns to the user — i.e. "your turn".
 *
 * Mirror of pi's own title format:
 *   Pi sets the title from `modes/interactive/interactive-mode.js`:
 *
 *     `${APP_TITLE} - ${sessionName} - ${cwdBasename}`   // when named
 *     `${APP_TITLE} - ${cwdBasename}`                    // when unnamed
 *
 *   APP_TITLE defaults to "π" (Greek small pi, U+03C0); it's overridden
 *   only if the pi package's package.json has `piConfig.name` set —
 *   essentially only in forks/rebrands. We hardcode "π" here because the
 *   constant isn't exposed to extensions. If you ever rebrand pi, also
 *   update APP_TITLE below.
 *
 * Pi only calls its own updateTerminalTitle() in three spots (session
 * start, custom-editor close, `session_info_changed`), not on every
 * render or turn — so our marker sticks once written and isn't fighting
 * pi for the title. The only visible artifact: if a `session_info_changed`
 * event fires while attention is set, pi's handler will briefly drop the
 * marker; it returns on the next `agent_end`. Acceptable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const APP_TITLE = "π";
const MARKER = "● ";

/** Compute the base ("idle") title — mirrors pi's interactive-mode logic. */
function baseTitle(ctx: ExtensionContext): string {
	const cwd = basename(ctx.cwd) || ctx.cwd;
	const session = ctx.sessionManager.getSessionName();
	return session ? `${APP_TITLE} - ${session} - ${cwd}` : `${APP_TITLE} - ${cwd}`;
}

function setIdle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setTitle(baseTitle(ctx));
}

function setAttention(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setTitle(MARKER + baseTitle(ctx));
}

export default function (pi: ExtensionAPI) {
	// On session start, ensure we begin in the idle state. Pi itself also
	// sets the title here, so this is mostly defensive (e.g. for /resume
	// into a session that ended in the attention state and whose title
	// was persisted by the terminal across the relaunch).
	pi.on("session_start", async (_event, ctx) => {
		setIdle(ctx);
	});

	// Agent finished its loop → mark the tab.
	pi.on("agent_end", async (_event, ctx) => {
		setAttention(ctx);
	});

	// User started typing the next prompt → clear the mark immediately,
	// don't wait for the agent to actually pick it up.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" as const };
		setIdle(ctx);
		return { action: "continue" as const };
	});

	// Belt-and-braces: covers RPC/programmatic inputs that bypass the
	// interactive `input` event and any case where the agent loop kicks
	// off without us seeing the input.
	pi.on("before_agent_start", async (_event, ctx) => {
		setIdle(ctx);
	});
}
