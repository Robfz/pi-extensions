/**
 * approvals.ts with PI_CODING_AGENT_DIR pointed at a temp dir (pi's getAgentDir() reads it on every call),
 * so the real ~/.pi/agent/workflow-approvals.json is never touched.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { approvalsPath, isAutoApproved, projectKey, setAutoApproved } from "../approvals.ts";

const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-approvals-test-")));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

before(() => {
	process.env.PI_CODING_AGENT_DIR = path.join(agentDir, "agent");
	// Guard: never run against the real agent dir.
	assert.ok(approvalsPath().startsWith(agentDir), `approvals file ${approvalsPath()} is not under the temp dir`);
});

after(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	fs.rmSync(agentDir, { recursive: true, force: true });
});

let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

describe("approvals", () => {
	test("missing file → nothing approved", () => {
		assert.equal(fs.existsSync(approvalsPath()), false);
		assert.equal(isAutoApproved("/some/project"), false);
	});

	test("setAutoApproved persists per project with mode 0600, creating the agent dir", async () => {
		await setAutoApproved("/proj/a");
		assert.equal(isAutoApproved("/proj/a"), true);
		assert.equal(isAutoApproved("/proj/b"), false);
		assert.equal(isAutoApproved("/proj"), false, "no prefix matching");
		const data = JSON.parse(fs.readFileSync(approvalsPath(), "utf8"));
		assert.equal(data.version, 1);
		assert.ok(!Number.isNaN(Date.parse(data.projects["/proj/a"].approvedAt)));
		if (process.platform !== "win32") assert.equal(fs.statSync(approvalsPath()).mode & 0o777, 0o600);
	});

	test("concurrent approvals are all kept", async () => {
		await Promise.all(["/p/1", "/p/2", "/p/3", "/p/4"].map((k) => setAutoApproved(k)));
		for (const k of ["/proj/a", "/p/1", "/p/2", "/p/3", "/p/4"]) assert.equal(isAutoApproved(k), true, k);
	});

	test("prototype keys are not approvals", () => {
		assert.equal(isAutoApproved("__proto__"), false);
		assert.equal(isAutoApproved("toString"), false);
	});

	test("corrupt or wrong-shaped file → treated as empty, then rewritten", async () => {
		fs.writeFileSync(approvalsPath(), "{not json");
		assert.equal(isAutoApproved("/proj/a"), false);
		fs.writeFileSync(approvalsPath(), JSON.stringify({ version: 1, projects: "nope" }));
		assert.equal(isAutoApproved("/proj/a"), false);
		await setAutoApproved("/proj/c");
		assert.equal(isAutoApproved("/proj/c"), true);
		assert.equal(isAutoApproved("/proj/a"), false);
	});

	test("projectKey: git toplevel inside a repo, resolved cwd otherwise", { skip: hasGit ? false : "git not available" }, () => {
		const plain = path.join(agentDir, "plain");
		fs.mkdirSync(plain, { recursive: true });
		// agentDir is under the OS temp dir, normally not inside a git repo
		assert.equal(projectKey(path.join(plain, ".")), plain);

		const repo = path.join(agentDir, "repo");
		fs.mkdirSync(path.join(repo, "deep", "er"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo });
		assert.equal(projectKey(path.join(repo, "deep", "er")), repo);
		assert.equal(projectKey(repo), repo);
	});
});
