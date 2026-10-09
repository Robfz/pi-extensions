/**
 * Saved ultraspawn discovery: `*.js` files holding an ultraspawn script (async function body, same form as
 * an inline `spawn({script})`), named by file stem. User scope: `~/.pi/agent/ultraspawns/` (entries are
 * usually symlinks into this repo). Project scope: the nearest `.pi/ultraspawns/` at or above cwd.
 * Scopes select directories exactly as for agents; with "both", a project ultraspawn wins a name clash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentScope, findNearestProjectDir } from "./agents.ts";

export interface SavedUltraspawn {
	name: string;
	/** First line of the leading `//` comment header, minus a `<name>:` prefix; "" when absent. */
	description: string;
	source: "user" | "project";
	filePath: string;
	script: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function isValidUltraspawnName(name: string): boolean {
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

function loadUltraspawnsFromDir(dir: string, source: "user" | "project"): SavedUltraspawn[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const ultraspawns: SavedUltraspawn[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".js")) continue;
		const name = entry.slice(0, -3);
		if (!isValidUltraspawnName(name)) continue;
		const filePath = path.join(dir, entry);
		// statSync follows symlinks, so linked files count and links to directories don't.
		if (!isFile(filePath)) continue;
		let script: string;
		try {
			script = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		ultraspawns.push({ name, description: describe(name, script), source, filePath, script });
	}
	return ultraspawns;
}

export function discoverUltraspawns(cwd: string, scope: AgentScope): SavedUltraspawn[] {
	const byName = new Map<string, SavedUltraspawn>();
	if (scope !== "project") {
		for (const wf of loadUltraspawnsFromDir(path.join(getAgentDir(), "ultraspawns"), "user")) byName.set(wf.name, wf);
	}
	if (scope !== "user") {
		const projectDir = findNearestProjectDir(cwd, "ultraspawns");
		if (projectDir) for (const wf of loadUltraspawnsFromDir(projectDir, "project")) byName.set(wf.name, wf);
	}
	return Array.from(byName.values());
}

/** Null for an invalid or unknown name. */
export function resolveUltraspawn(cwd: string, name: string, scope: AgentScope): SavedUltraspawn | null {
	if (!isValidUltraspawnName(name)) return null;
	return discoverUltraspawns(cwd, scope).find((wf) => wf.name === name) ?? null;
}
