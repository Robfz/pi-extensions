/**
 * Source of the workflow worker thread, run with `new Worker(WORKFLOW_WORKER_SOURCE, { eval: true, workerData })`.
 * Plain CommonJS: an eval worker cannot load TypeScript. The script runs in a bare `node:vm` context
 * (no require/process/timers) as the body of an async function receiving the workflow API.
 * Host protocol: see HostToWorker / WorkerToHost in types.ts.
 */

export const WORKFLOW_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const pending = new Map();
let nextId = 1;

parentPort.on("message", (m) => {
	if (!m || m.type !== "response") return;
	const p = pending.get(m.id);
	if (!p) return;
	pending.delete(m.id);
	if (m.ok) p.resolve(m.value);
	else p.reject(new Error(m.error));
});

function call(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		parentPort.postMessage({ type: "call", id, method, params });
	});
}

function postError(err) {
	const isObj = err !== null && typeof err === "object";
	const message = isObj && typeof err.message === "string" ? err.message : String(err);
	const name = isObj && typeof err.name === "string" ? err.name : "";
	const stack = isObj && typeof err.stack === "string" ? err.stack : undefined;
	parentPort.postMessage({ type: "error", message: name && name !== "Error" ? name + ": " + message : message, stack });
}

process.on("unhandledRejection", (err) => postError(err));

let currentPhase;

function agent(prompt, opts) {
	if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent(prompt, opts?): prompt must be a non-empty string");
	if (opts !== undefined && (opts === null || typeof opts !== "object")) throw new TypeError("agent(prompt, opts?): opts must be an object");
	const o = opts || {};
	const params = { prompt, phase: currentPhase };
	for (const k of ["agent", "schema", "timeout", "isolation", "label"]) if (o[k] !== undefined) params[k] = o[k];
	return call("agent", params);
}

function parallel(items, fn) {
	if (!Array.isArray(items)) throw new TypeError("parallel(items, fn?): items must be an array");
	if (typeof fn === "function") return Promise.all(items.map((it, i) => fn(it, i)));
	return Promise.all(items.map((x) => (typeof x === "function" ? x() : x)));
}

async function pipeline(stages, input) {
	if (!Array.isArray(stages)) throw new TypeError("pipeline(stages, input?): stages must be an array of functions");
	let value = input;
	for (let i = 0; i < stages.length; i++) value = await stages[i](value, i);
	return value;
}

async function phase(name, fn) {
	if (typeof name !== "string" || !name) throw new TypeError("phase(name, fn): name must be a non-empty string");
	if (typeof fn !== "function") throw new TypeError("phase(name, fn): fn must be a function");
	parentPort.postMessage({ type: "phase", name, event: "start" });
	const prev = currentPhase;
	currentPhase = name;
	try {
		return await fn();
	} finally {
		currentPhase = prev;
		parentPort.postMessage({ type: "phase", name, event: "end" });
	}
}

function fmt(v) {
	if (typeof v === "string") return v;
	try {
		const s = JSON.stringify(v);
		return s === undefined ? String(v) : s;
	} catch {
		return String(v);
	}
}

function log(...parts) {
	parentPort.postMessage({ type: "log", text: parts.map(fmt).join(" ") });
}

function applyPatch(patch) {
	return call("applyPatch", { patch });
}

const args = Object.freeze(structuredClone(workerData.args ?? {}));
const api = { agent, parallel, pipeline, phase, log, args, applyPatch, console: { log, info: log, warn: log, error: log } };

let main;
try {
	const context = vm.createContext({});
	main = vm.runInContext(
		"(async ({ agent, parallel, pipeline, phase, log, args, applyPatch, console }) => {\n" + workerData.script + "\n})",
		context,
		{ filename: "workflow.js", lineOffset: -1 },
	);
} catch (err) {
	postError(err);
}

if (main) {
	main(api).then(
		(result) => {
			try {
				parentPort.postMessage({ type: "done", result });
			} catch {
				parentPort.postMessage({
					type: "error",
					message: "workflow returned a value that cannot be serialized (functions/class instances); return plain data",
				});
			}
		},
		(err) => postError(err),
	);
}
`;
