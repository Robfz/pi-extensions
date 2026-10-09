/**
 * Saved workflow discovery: `*.js` files holding a workflow script (async function body, same form as
 * an inline `spawn({script})`), named by file stem. User scope: `~/.pi/agent/workflows/` (entries are
 * usually symlinks into this repo). Project scope: the nearest `.pi/workflows/` at or above cwd.
 * Scopes select directories exactly as for agents; with "both", a project workflow wins a name clash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentScope, findNearestProjectDir } from "./agents.ts";

export interface SavedWorkflow {
	name: string;
	/** First line of the leading `//` comment header, minus a `<name>:` prefix; "" when absent. */
	description: string;
	source: "user" | "project";
	filePath: string;
	script: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function isValidWorkflowName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function describe(name: string, script: string): string {
	const first = script.split("\n", 1)[0].trim();
	if (!first.startsWith("//")) return "";
	const text = first.replace(/^\/\/\s*/, "");
	return text.startsWith(`${name}:`) ? text.slice(name.length + 1).trim() : text;
}

function loadWorkflowsFromDir(dir: string, source: "user" | "project"): SavedWorkflow[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const workflows: SavedWorkflow[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".js")) continue;
		const name = entry.slice(0, -3);
		if (!isValidWorkflowName(name)) continue;
		const filePath = path.join(dir, entry);
		// statSync follows symlinks, so linked files count and links to directories don't.
		if (!isFile(filePath)) continue;
		let script: string;
		try {
			script = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		workflows.push({ name, description: describe(name, script), source, filePath, script });
	}
	return workflows;
}

export function discoverWorkflows(cwd: string, scope: AgentScope): SavedWorkflow[] {
	const byName = new Map<string, SavedWorkflow>();
	if (scope !== "project") {
		for (const wf of loadWorkflowsFromDir(path.join(getAgentDir(), "workflows"), "user")) byName.set(wf.name, wf);
	}
	if (scope !== "user") {
		const projectDir = findNearestProjectDir(cwd, "workflows");
		if (projectDir) for (const wf of loadWorkflowsFromDir(projectDir, "project")) byName.set(wf.name, wf);
	}
	return Array.from(byName.values());
}

/** Null for an invalid or unknown name. */
export function resolveWorkflow(cwd: string, name: string, scope: AgentScope): SavedWorkflow | null {
	if (!isValidWorkflowName(name)) return null;
	return discoverWorkflows(cwd, scope).find((wf) => wf.name === name) ?? null;
}
