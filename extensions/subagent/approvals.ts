/**
 * Per-project auto-approval for workflow scripts, stored in `<agentDir>/workflow-approvals.json`:
 * `{ "version": 1, "projects": { "<abs project root>": { "approvedAt": "<ISO>" } } }`.
 * User-level so a cloned repo cannot pre-approve itself.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

interface ApprovalsFile {
	version: 1;
	projects: Record<string, { approvedAt: string }>;
}

export function approvalsPath(): string {
	return path.join(getAgentDir(), "workflow-approvals.json");
}

/** Git toplevel of `cwd`, else the resolved `cwd`. */
export function projectKey(cwd: string): string {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (out) return path.resolve(out);
	} catch {
		/* not a git repo */
	}
	return path.resolve(cwd);
}

function readApprovals(): ApprovalsFile {
	try {
		const parsed = JSON.parse(fs.readFileSync(approvalsPath(), "utf-8"));
		if (parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object") {
			return { version: 1, projects: parsed.projects };
		}
	} catch {
		/* missing or corrupt → empty */
	}
	return { version: 1, projects: {} };
}

export function isAutoApproved(key: string): boolean {
	return Object.hasOwn(readApprovals().projects, key);
}

export async function setAutoApproved(key: string): Promise<void> {
	const file = approvalsPath();
	await withFileMutationQueue(file, async () => {
		const data = readApprovals();
		data.projects[key] = { approvedAt: new Date().toISOString() };
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	});
}
