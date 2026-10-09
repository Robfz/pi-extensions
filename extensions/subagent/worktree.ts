/**
 * Git worktree isolation for ultraspawn agents and `applyPatch` on the user's checkout.
 * An isolated worktree is a detached checkout of HEAD plus the checkout's uncommitted and untracked
 * changes, frozen in a throwaway base commit so the agent's changes diff cleanly against it.
 * All git calls go through execFile (no shell) with a buffer cap and timeout; hooks are disabled.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "./types.ts";

export interface IsolatedWorktree {
	path: string;
	baseCommit: string;
}

export type ApplyPatchResult = { ok: true } | { ok: false; error: string };

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
/** Prepended to every git invocation: no repo hooks, no commit signing, raw paths. */
const GIT_CONFIG = ["-c", `core.hooksPath=${os.devNull}`, "-c", "commit.gpgSign=false", "-c", "core.quotePath=false"];

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[...GIT_CONFIG, ...args],
			{ cwd, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
			(err, stdout, stderr) => {
				if (err) {
					const detail = String(stderr || "").trim() || err.message;
					reject(new Error(`git ${args[0]} failed: ${detail}`));
				} else resolve(stdout);
			},
		);
	});
}

/** Top-level directory of the git checkout containing `cwd`, or null when it is not in one. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
	try {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		return root || null;
	} catch {
		return null;
	}
}

/**
 * Directory inside a worktree that corresponds to `cwd` inside the checkout rooted at `repoRoot`,
 * created when git did not check it out (e.g. an empty directory); the worktree root as a fallback.
 */
export function worktreeCwd(repoRoot: string, wtPath: string, cwd: string): string {
	let real = cwd;
	try {
		real = fs.realpathSync(cwd);
	} catch {
		/* keep cwd */
	}
	const rel = path.relative(repoRoot, real);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return wtPath;
	const dir = path.join(wtPath, rel);
	try {
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return wtPath;
	}
}

/** Creates `<runDir>/wt-<index>`: HEAD + uncommitted + untracked changes, committed as the base. */
export async function createIsolatedWorktree(repoRoot: string, runDir: string, index: number): Promise<IsolatedWorktree> {
	fs.mkdirSync(runDir, { recursive: true });
	const wt = path.join(runDir, `wt-${index}`);
	await git(repoRoot, ["worktree", "add", "--detach", wt, "HEAD"]);
	try {
		const stash = (await git(repoRoot, ["stash", "create"])).trim();
		if (stash) await git(wt, ["stash", "apply", stash]);
		const untracked = (await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
		for (const rel of untracked) {
			const dst = path.join(wt, rel);
			await fs.promises.mkdir(path.dirname(dst), { recursive: true });
			await fs.promises.cp(path.join(repoRoot, rel), dst, { recursive: true, verbatimSymlinks: true });
		}
		await git(wt, ["add", "-A"]);
		await git(wt, [
			"-c",
			"user.name=pi-ultraspawn",
			"-c",
			"user.email=pi-ultraspawn@localhost",
			"commit",
			"-q",
			"--no-verify",
			"--allow-empty",
			"-m",
			`pi-ultraspawn base (${path.basename(runDir)})`,
		]);
		const baseCommit = (await git(wt, ["rev-parse", "HEAD"])).trim();
		return { path: wt, baseCommit };
	} catch (err) {
		await removeWorktree(repoRoot, wt);
		throw err;
	}
}

/** The agent's changes since the base commit (committed or not, incl. new, deleted, and binary files). */
export async function captureWorktreePatch(wt: IsolatedWorktree): Promise<string> {
	await git(wt.path, ["add", "-A"]);
	return git(wt.path, ["diff", "--cached", "--binary", wt.baseCommit]);
}

/** Removes a worktree and its git metadata; never throws. */
export async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
	try {
		await git(repoRoot, ["worktree", "remove", "--force", "--force", wtPath]);
	} catch {
		try {
			fs.rmSync(wtPath, { recursive: true, force: true });
		} catch {
			/* best effort; the run dir sweep retries */
		}
	}
	try {
		await git(repoRoot, ["worktree", "prune"]);
	} catch {
		/* best effort */
	}
}

/** Deletes a run's worktree directory and prunes stale worktree entries; never throws. */
export async function sweepRunDir(repoRoot: string | null, runDir: string): Promise<void> {
	try {
		fs.rmSync(runDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	if (!repoRoot) return;
	try {
		await git(repoRoot, ["worktree", "prune"]);
	} catch {
		/* best effort */
	}
}

/** Applies `patch` to the checkout's working tree, all or nothing (`git apply --check` first). */
export async function applyPatchToCheckout(repoRoot: string, patch: string): Promise<ApplyPatchResult> {
	if (!patch.trim()) return { ok: true };
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-patch-"));
	const file = path.join(dir, "change.patch");
	try {
		await fs.promises.writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`);
		try {
			await git(repoRoot, ["apply", "--check", file]);
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
		try {
			await git(repoRoot, ["apply", file]);
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
		return { ok: true };
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}
