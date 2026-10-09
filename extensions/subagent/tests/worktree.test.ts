/** worktree.ts against real git repos in temp dirs, plus runWorkflow end-to-end with isolation. Skipped without git. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import type { WorkflowAgentResult } from "../types.ts";
import { runWorkflow, type WorkflowRunOptions } from "../workflow.ts";
import {
	applyPatchToCheckout,
	captureWorktreePatch,
	createIsolatedWorktree,
	getRepoRoot,
	type IsolatedWorktree,
	removeWorktree,
	sweepRunDir,
} from "../worktree.ts";
import { type FakePlan, type FakeReply, makeFakeRunner, nextRunId, testAgents } from "./fake-runner.ts";

let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}
const skip = hasGit ? false : "git not available";

const tmpRoots: string[] = [];
after(() => {
	for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Repo with a committed a.txt and sub/keep.txt; returns its (realpath'd) root. */
function makeRepo(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wt-test-")));
	tmpRoots.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "test");
	git(dir, "config", "user.email", "test@localhost");
	git(dir, "config", "commit.gpgSign", "false");
	fs.writeFileSync(path.join(dir, "a.txt"), "line1\nline2\n");
	fs.mkdirSync(path.join(dir, "sub"));
	fs.writeFileSync(path.join(dir, "sub", "keep.txt"), "keep\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

function makeRunDir(): string {
	const dir = path.join(fs.realpathSync(os.tmpdir()), `pi-wt-run-${nextRunId()}`);
	tmpRoots.push(dir);
	return dir;
}

function worktreeCount(repo: string): number {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((l) => l.startsWith("worktree ")).length;
}

const BINARY = Buffer.from([0, 1, 2, 3, 255, 0, 10, 13, 0, 42]);

describe("isolated worktrees", { skip }, () => {
	let repo: string;
	let runDir: string;
	let head: string;
	let wt: IsolatedWorktree;
	let patch: string;

	before(async () => {
		repo = makeRepo();
		runDir = makeRunDir();
		head = git(repo, "rev-parse", "HEAD").trim();
		fs.writeFileSync(path.join(repo, "a.txt"), "line1\nline2 modified\n");
		fs.writeFileSync(path.join(repo, "u.txt"), "untracked\n");
		fs.mkdirSync(path.join(repo, "newdir"));
		fs.writeFileSync(path.join(repo, "newdir", "deep.txt"), "deep\n");
	});

	test("getRepoRoot", async () => {
		assert.equal(await getRepoRoot(path.join(repo, "sub")), repo);
		const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wt-norepo-"));
		tmpRoots.push(notRepo);
		assert.equal(await getRepoRoot(notRepo), null);
	});

	test("carries uncommitted and untracked changes on a base commit over HEAD", async () => {
		wt = await createIsolatedWorktree(repo, runDir, 1);
		assert.equal(wt.path, path.join(runDir, "wt-1"));
		assert.equal(fs.readFileSync(path.join(wt.path, "a.txt"), "utf8"), "line1\nline2 modified\n");
		assert.equal(fs.readFileSync(path.join(wt.path, "u.txt"), "utf8"), "untracked\n");
		assert.equal(fs.readFileSync(path.join(wt.path, "newdir", "deep.txt"), "utf8"), "deep\n");
		assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), wt.baseCommit);
		assert.equal(git(wt.path, "rev-parse", "HEAD^").trim(), head);
		assert.equal(git(wt.path, "status", "--porcelain").trim(), "", "base commit captures everything");
		// the user's checkout is untouched
		assert.equal(git(repo, "rev-parse", "HEAD").trim(), head);
		assert.match(git(repo, "status", "--porcelain"), /M a\.txt/);
		assert.equal(git(repo, "stash", "list").trim(), "");
		assert.equal(worktreeCount(repo), 2);
	});

	test("patch includes new, modified, deleted, and binary files only", async () => {
		fs.writeFileSync(path.join(wt.path, "new.txt"), "brand new\n");
		fs.writeFileSync(path.join(wt.path, "a.txt"), "line1 agent\nline2 modified\n");
		fs.writeFileSync(path.join(wt.path, "bin.dat"), BINARY);
		fs.rmSync(path.join(wt.path, "sub", "keep.txt"));
		patch = await captureWorktreePatch(wt);
		assert.match(patch, /diff --git a\/new\.txt b\/new\.txt/);
		assert.match(patch, /\+brand new/);
		assert.match(patch, /diff --git a\/a\.txt b\/a\.txt/);
		assert.match(patch, /-line1\n\+line1 agent/);
		assert.match(patch, /diff --git a\/bin\.dat b\/bin\.dat/);
		assert.match(patch, /GIT binary patch/);
		assert.match(patch, /deleted file mode/);
		assert.doesNotMatch(patch, /u\.txt|deep\.txt|line2 modified\n\+/, "pre-existing local changes are in the base, not the patch");
	});

	test("removeWorktree removes the directory and git metadata", async () => {
		await removeWorktree(repo, wt.path);
		assert.equal(fs.existsSync(wt.path), false);
		assert.equal(worktreeCount(repo), 1);
		// idempotent, never throws
		await removeWorktree(repo, wt.path);
	});

	test("applyPatchToCheckout applies the agent's patch to the checkout", async () => {
		const res = await applyPatchToCheckout(repo, patch);
		assert.deepEqual(res, { ok: true });
		assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "brand new\n");
		assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "line1 agent\nline2 modified\n");
		assert.deepEqual(fs.readFileSync(path.join(repo, "bin.dat")), BINARY);
		assert.equal(fs.existsSync(path.join(repo, "sub", "keep.txt")), false);
	});

	test("conflicting patch → ok:false and the checkout is unchanged (all or nothing)", async () => {
		const status = git(repo, "status", "--porcelain");
		const aBefore = fs.readFileSync(path.join(repo, "a.txt"), "utf8");
		// Re-applying the same patch conflicts on every file; prepend a clean new file to check atomicity.
		const extra = "diff --git a/z.txt b/z.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/z.txt\n@@ -0,0 +1 @@\n+z\n";
		const res = await applyPatchToCheckout(repo, extra + patch);
		assert.equal(res.ok, false);
		assert.ok(!res.ok && res.error.length > 0);
		assert.equal(git(repo, "status", "--porcelain"), status);
		assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), aBefore);
		assert.equal(fs.existsSync(path.join(repo, "z.txt")), false);
	});

	test("empty patch → ok:true, nothing touched", async () => {
		const status = git(repo, "status", "--porcelain");
		assert.deepEqual(await applyPatchToCheckout(repo, ""), { ok: true });
		assert.deepEqual(await applyPatchToCheckout(repo, "  \n"), { ok: true });
		assert.equal(git(repo, "status", "--porcelain"), status);
	});

	test("sweepRunDir removes leftover worktrees and prunes", async () => {
		const leftover = await createIsolatedWorktree(repo, runDir, 2);
		assert.equal(worktreeCount(repo), 2);
		await sweepRunDir(repo, runDir);
		assert.equal(fs.existsSync(runDir), false);
		assert.equal(fs.existsSync(leftover.path), false);
		assert.equal(worktreeCount(repo), 1);
		await sweepRunDir(null, runDir); // no repo, missing dir: still fine
	});

	test("unborn HEAD → createIsolatedWorktree throws and leaves nothing", async () => {
		const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wt-empty-")));
		tmpRoots.push(empty);
		git(empty, "init", "-q");
		const dir = makeRunDir();
		await assert.rejects(createIsolatedWorktree(empty, dir, 1));
		assert.equal(fs.existsSync(path.join(dir, "wt-1")), false);
	});
});

describe("runWorkflow with isolation: worktree", { skip }, () => {
	function opts(repo: string, plan: FakePlan | FakeReply, extra: Partial<WorkflowRunOptions> = {}) {
		const fake = makeFakeRunner(plan);
		const runId = nextRunId();
		const outcome = runWorkflow({
			runId,
			name: "inline",
			source: "inline",
			script: "",
			args: {},
			cwd: repo,
			agents: testAgents(),
			agentScope: "user",
			projectAgentsDir: null,
			runner: fake.runner,
			...extra,
		});
		return { fake, outcome, runDir: path.join(os.tmpdir(), `pi-workflow-${runId}`) };
	}

	test("agent edits its worktree, worktree is removed before the script continues, applyPatch lands it", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "dirty.txt"), "local\n");
		const cwd = path.join(repo, "sub");
		let isolatedCwd = "";
		const plan: FakePlan = (spec, i) => {
			if (i === 0) {
				return {
					effect: (s) => {
						isolatedCwd = s.defaultCwd;
						// sees the checkout's untracked file, writes a new one
						assert.equal(fs.readFileSync(path.join(s.defaultCwd, "..", "dirty.txt"), "utf8"), "local\n");
						fs.writeFileSync(path.join(s.defaultCwd, "made.txt"), "from agent\n");
					},
					output: "made",
				};
			}
			return { output: fs.existsSync(isolatedCwd) ? "worktree still there" : "worktree gone" };
		};
		const script = `
			const r = await agent("make a file", { isolation: "worktree" });
			const check = await agent("check");
			const applied = await applyPatch(r.patch);
			return { r, check: check.output, applied };`;
		const { fake, outcome, runDir } = opts(cwd, plan, { script });
		const { details, result } = await outcome;
		assert.equal(details.status, "done", details.error);
		const { r, check, applied } = result as { r: WorkflowAgentResult; check: string; applied: unknown };
		assert.equal(r.ok, true);
		assert.match(r.patch ?? "", /sub\/made\.txt/);
		assert.equal(check, "worktree gone");
		assert.deepEqual(applied, { ok: true });
		assert.ok(isolatedCwd.startsWith(runDir), `child cwd ${isolatedCwd} inside ${runDir}`);
		assert.ok(isolatedCwd.endsWith(`${path.sep}sub`), "child cwd mirrors the subdirectory");
		assert.equal(fake.specs[1].defaultCwd, cwd, "non-isolated agents run in cwd");
		assert.equal(fs.readFileSync(path.join(repo, "sub", "made.txt"), "utf8"), "from agent\n");
		assert.equal(fs.existsSync(runDir), false, "run dir swept");
		assert.equal(worktreeCount(repo), 1);
		assert.equal(details.agents[0].isolated, true);
	});

	test("abort during an isolated agent leaves no worktree or run dir", async () => {
		const repo = makeRepo();
		const ac = new AbortController();
		const script = `await parallel([0, 1], (i) => agent("slow " + i, { isolation: "worktree" })); return "unreachable";`;
		const { fake, outcome, runDir } = opts(repo, { delayMs: 30_000 }, { script, signal: ac.signal });
		await fake.waitForCalls(2);
		assert.equal(worktreeCount(repo), 3);
		ac.abort();
		const { details } = await outcome;
		assert.equal(details.status, "aborted");
		assert.equal(fs.existsSync(runDir), false);
		assert.equal(worktreeCount(repo), 1);
		assert.equal(git(repo, "status", "--porcelain").trim(), "");
	});

	test("worktree creation failure → reason isolation, no child spawned, run continues", async () => {
		const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wt-unborn-")));
		tmpRoots.push(repo);
		git(repo, "init", "-q");
		const script = `const r = await agent("x", { isolation: "worktree" }); return [r.ok, r.reason, (await agent("y")).ok];`;
		const { fake, outcome, runDir } = opts(repo, {}, { script });
		const { details, result } = await outcome;
		assert.equal(details.status, "done", details.error);
		assert.deepEqual(result, [false, "isolation", true]);
		assert.equal(fake.specs.length, 1);
		assert.equal(fs.existsSync(runDir), false);
	});
});
