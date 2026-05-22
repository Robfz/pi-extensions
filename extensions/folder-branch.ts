/**
 * folder-branch status entry
 *
 * Shows the current folder name in the footer, plus the git branch if cwd is
 * inside a git repository. Refreshes on session start and after each turn so
 * branch switches (yours or the agent's) are picked up.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const STATUS_KEY = "folder-branch";

async function getGitBranch(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await exec("git", ["-C", cwd, "branch", "--show-current"], {
			timeout: 500,
		});
		const branch = stdout.trim();
		return branch || null; // empty == detached HEAD
	} catch {
		return null; // not a git repo, git missing, or timeout
	}
}

async function update(ctx: ExtensionContext): Promise<void> {
	const folder = basename(ctx.cwd) || ctx.cwd;
	const branch = await getGitBranch(ctx.cwd);
	const theme = ctx.ui.theme;

	const text = branch
		? theme.fg("dim", folder) + " " + theme.fg("accent", `(${branch})`)
		: theme.fg("dim", folder);

	ctx.ui.setStatus(STATUS_KEY, text);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await update(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await update(ctx);
	});
}
