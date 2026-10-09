/** saved-workflows.ts discovery with PI_CODING_AGENT_DIR pointed at a temp dir; project dirs are temp dirs too. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { discoverWorkflows, isValidWorkflowName, resolveWorkflow } from "../saved-workflows.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-saved-wf-test-")));
const agentDir = path.join(root, "agent");
const userDir = path.join(agentDir, "workflows");
const project = path.join(root, "project");
const projectDir = path.join(project, ".pi", "workflows");
const nested = path.join(project, "src", "deep");
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

function write(file: string, text: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

before(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	write(path.join(userDir, "review.js"), "// review: multi-angle review\nreturn 1;");
	write(path.join(userDir, "shared.js"), "// user version\nreturn 'user';");
	write(path.join(userDir, "plain.js"), "return 0;");
	write(path.join(userDir, "notes.md"), "not a workflow");
	write(path.join(userDir, "bad name.js"), "return 0;");
	fs.mkdirSync(path.join(userDir, "dir.js"));
	write(path.join(root, "elsewhere", "linked.js"), "// linked: via symlink\nreturn 2;");
	fs.symlinkSync(path.join(root, "elsewhere", "linked.js"), path.join(userDir, "linked.js"));
	write(path.join(projectDir, "shared.js"), "// project version\nreturn 'project';");
	write(path.join(projectDir, "local.js"), "return 'local';");
	fs.mkdirSync(nested, { recursive: true });
});

after(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

const names = (scope: "user" | "project" | "both") =>
	discoverWorkflows(nested, scope)
		.map((w) => `${w.name}:${w.source}`)
		.sort();

describe("saved workflows", () => {
	test("user scope: only ~/.pi/agent/workflows, .js files with valid names, symlinks followed", () => {
		assert.deepEqual(names("user"), ["linked:user", "plain:user", "review:user", "shared:user"]);
	});

	test("project workflows are opt-in: project scope sees only .pi/workflows found above cwd", () => {
		assert.deepEqual(names("project"), ["local:project", "shared:project"]);
	});

	test("both: union, project wins a name clash", () => {
		assert.deepEqual(names("both"), ["linked:user", "local:project", "plain:user", "review:user", "shared:project"]);
		assert.equal(resolveWorkflow(nested, "shared", "both")?.script, "// project version\nreturn 'project';");
		assert.equal(resolveWorkflow(nested, "shared", "user")?.source, "user");
	});

	test("resolveWorkflow: unknown, out-of-scope, and invalid names → null", () => {
		assert.equal(resolveWorkflow(nested, "local", "user"), null);
		assert.equal(resolveWorkflow(nested, "local", "both")?.filePath, path.join(projectDir, "local.js"));
		assert.equal(resolveWorkflow(nested, "ghost", "both"), null);
		assert.equal(resolveWorkflow(nested, "../review", "user"), null);
		assert.equal(isValidWorkflowName("a/b"), false);
		assert.equal(isValidWorkflowName("review-v2.1"), true);
	});

	test("description: first // line minus a `<name>:` prefix", () => {
		const byName = new Map(discoverWorkflows(nested, "both").map((w) => [w.name, w.description]));
		assert.equal(byName.get("review"), "multi-angle review");
		assert.equal(byName.get("linked"), "via symlink");
		assert.equal(byName.get("shared"), "project version");
		assert.equal(byName.get("plain"), "");
	});
});
