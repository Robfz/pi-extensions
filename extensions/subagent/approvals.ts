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

/** A project agent a workflow run could use; `overridesUser` when it shadows a user agent of the same name. */
export interface ProjectAgentRef {
	name: string;
	overridesUser: boolean;
}

export interface WorkflowGateInput {
	name: string;
	hasUI: boolean;
	autoApproved: boolean;
	source: "inline" | "user" | "project";
	agentScope: "user" | "project" | "both";
	/** Project agents in the discovered agent set (empty for scope "user"). */
	projectAgents: ProjectAgentRef[];
	/** Directory the project agents come from, for messages. */
	projectAgentsDir?: string | null;
}

export type WorkflowGateDecision =
	| { action: "run" }
	/** Run without a dialog, telling the user via `message`. */
	| { action: "notify"; message: string }
	/** Ask the user; `projectAgentsNote` (if any) belongs in the dialog. */
	| { action: "confirm"; projectAgentsNote?: string }
	| { action: "refuse"; message: string };

/** One line naming the project agents and the user agents they override; undefined when there are none. */
export function describeProjectAgents(agents: ProjectAgentRef[], dir?: string | null): string | undefined {
	if (agents.length === 0) return undefined;
	const names = agents.map((a) => (a.overridesUser ? `${a.name} (overrides user agent ${a.name})` : a.name));
	return `Project agents (repo-controlled${dir ? `, from ${dir}` : ""}): ${names.join(", ")}`;
}

/**
 * Whether a workflow may run. Auto-approved projects run (with a notice when there is a UI).
 * Otherwise the UI asks; without a UI only a user-scope saved workflow with agentScope "user" runs,
 * since nothing repo-controlled (script or agents) is involved.
 */
export function decideWorkflowGate(input: WorkflowGateInput): WorkflowGateDecision {
	const note = describeProjectAgents(input.projectAgents, input.projectAgentsDir);
	if (input.autoApproved) {
		if (!input.hasUI) return { action: "run" };
		const message = `Workflow "${input.name}" auto-approved for this project${note ? `\n${note}` : ""}`;
		return { action: "notify", message };
	}
	if (input.hasUI) return note ? { action: "confirm", projectAgentsNote: note } : { action: "confirm" };
	if (input.source === "user" && input.agentScope === "user") return { action: "run" };
	const what =
		input.source === "inline"
			? "Inline workflow scripts"
			: input.source === "project"
				? "Project workflows"
				: `Workflows with agentScope "${input.agentScope}"`;
	return {
		action: "refuse",
		message:
			`${what} need interactive approval: without a UI only user workflows with agentScope "user" run unattended. ` +
			`Start a TUI session and choose "Auto-approve for this project" to allow them here.${note ? `\n${note}` : ""}`,
	};
}
