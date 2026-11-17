/**
 * herdr-tab-name extension
 *
 * When the session gets a name (`/name`, RPC, `pi.setSessionName()` — e.g. the
 * auto-name extension), renames the Herdr tab this pi runs in to match, so the
 * tab says what the session is about instead of its position number.
 *
 * Only renames a tab that still has Herdr's automatic numeric name ("1", "2",
 * ...). Any other name came from the user or from another agent in the same
 * tab, and whichever names the tab first wins, so a later `/name` leaves the
 * tab alone.
 *
 * Runs only inside a Herdr terminal (`HC_TERMINAL_ID` set) and only in
 * sessions with a UI: subagent pi processes inherit the terminal's env and
 * must not rename the tab. `herdr-app` runs on the machine pi runs on, whose
 * terminal ids match `HC_TERMINAL_ID`, so remote sessions need no special
 * handling.
 *
 * Fire-and-forget: never blocks the session, and fails silently (e.g. when the
 * Herdr app isn't running).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERDR = "herdr-app";
const TIMEOUT_MS = 3000;
const AUTO_TAB_NAME = /^\d+$/;

type HerdrTab = { id: string; name: string; terminals: { terminal: string }[] };
type HerdrLs = { spaces: { tabs: HerdrTab[] }[] };

function findTab(ls: HerdrLs, terminalId: string): HerdrTab | undefined {
	return ls.spaces
		.flatMap((space) => space.tabs)
		.find((tab) => tab.terminals.some((t) => t.terminal === terminalId));
}

async function renameIfAutoNamed(pi: ExtensionAPI, terminalId: string, name: string): Promise<void> {
	const ls = await pi.exec(HERDR, ["ls"], { timeout: TIMEOUT_MS });
	if (ls.code !== 0) return;

	const tab = findTab(JSON.parse(ls.stdout) as HerdrLs, terminalId);
	if (!tab || !AUTO_TAB_NAME.test(tab.name)) return;

	await pi.exec(HERDR, ["do", "tab.rename", JSON.stringify({ id: tab.id, name })], { timeout: TIMEOUT_MS });
}

export default function (pi: ExtensionAPI) {
	const terminalId = process.env.HC_TERMINAL_ID;
	if (!terminalId) return;

	pi.on("session_info_changed", (event, ctx) => {
		if (!ctx.hasUI || !event.name) return;
		renameIfAutoNamed(pi, terminalId, event.name).catch(() => {});
	});
}
