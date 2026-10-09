/** JSON Schema validation of ultraspawn agent output (TypeBox `Value`, which accepts plain JSON Schema objects). */

import { Value } from "typebox/value";
import { errorMessage } from "./types.ts";

/** Retries after the first attempt; a call runs at most MAX_SCHEMA_RETRIES + 1 child processes. */
export const MAX_SCHEMA_RETRIES = 3;
const MAX_ERRORS = 20;
const MAX_PREVIOUS_OUTPUT_CHARS = 20 * 1024;

const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

/** Parses the last ```json fence in `output`, or the whole trimmed output when there is no fence. */
export function extractJson(output: string): { value: unknown } | { error: string } {
	let last: string | undefined;
	for (const m of output.matchAll(JSON_FENCE)) last = m[1];
	const text = (last ?? output).trim();
	if (!text) return { error: "no JSON found: expected a ```json fenced block" };
	try {
		return { value: JSON.parse(text) };
	} catch (err) {
		const what = last === undefined ? "output is not a ```json block or bare JSON" : "```json block is not valid JSON";
		return { error: `${what}: ${errorMessage(err)}` };
	}
}

const SCHEMA_EVAL_ERROR = "schema could not be evaluated";
/** Values of each JSON type, so type-specific keywords at the top level are exercised. */
const PROBE_VALUES: unknown[] = [null, "", 0, false, [], {}];

/** First `pattern` / `patternProperties` key anywhere in the schema that is not a valid RegExp. */
function findInvalidPattern(node: unknown): string | undefined {
	if (Array.isArray(node)) {
		for (const item of node) {
			const bad = findInvalidPattern(item);
			if (bad !== undefined) return bad;
		}
		return undefined;
	}
	if (node === null || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	const patterns: string[] = [];
	if (typeof record.pattern === "string") patterns.push(record.pattern);
	if (record.patternProperties && typeof record.patternProperties === "object") {
		patterns.push(...Object.keys(record.patternProperties));
	}
	for (const p of patterns) {
		try {
			new RegExp(p, "u");
		} catch {
			return p;
		}
	}
	for (const value of Object.values(record)) {
		const bad = findInvalidPattern(value);
		if (bad !== undefined) return bad;
	}
	return undefined;
}

/** Why the validator cannot evaluate `schema`, or undefined when it can. */
export function schemaProblem(schema: object): string | undefined {
	const badPattern = findInvalidPattern(schema);
	if (badPattern !== undefined) return `${SCHEMA_EVAL_ERROR}: invalid pattern ${JSON.stringify(badPattern)}`;
	for (const probe of PROBE_VALUES) {
		const errors = validateAgainst(schema, probe);
		if (errors[0]?.startsWith(SCHEMA_EVAL_ERROR)) return errors[0];
	}
	return undefined;
}

/** Validation errors as `path: message` lines (at most 20); empty when `value` validates. */
export function validateAgainst(schema: object, value: unknown): string[] {
	try {
		if (Value.Check(schema as never, value)) return [];
		const errors: string[] = [];
		for (const e of Value.Errors(schema as never, value)) {
			errors.push(`${e.instancePath || "/"}: ${e.message}`);
			if (errors.length >= MAX_ERRORS) break;
		}
		return errors.length > 0 ? errors : ["/: value does not match the schema"];
	} catch (err) {
		return [`${SCHEMA_EVAL_ERROR}: ${errorMessage(err)}`];
	}
}

/** Output-format paragraph placed inside <ultraspawn-instructions>. */
export function schemaInstruction(schema: object): string {
	return `Your final response must contain exactly one fenced \`\`\`json block whose content is a JSON value validating against this JSON Schema (no prose required outside the block):
${JSON.stringify(schema)}`;
}

/** Suffix for a retry prompt: the previous raw output (≤ 20 KB) and its validation errors. */
export function schemaRetrySuffix(previousOutput: string, errors: string[]): string {
	const prev =
		previousOutput.length > MAX_PREVIOUS_OUTPUT_CHARS
			? `${previousOutput.slice(0, MAX_PREVIOUS_OUTPUT_CHARS)}\n[truncated]`
			: previousOutput;
	return `

<previous-attempt>
${prev}
</previous-attempt>
<validation-errors>
${errors.map((e) => `- ${e}`).join("\n")}
</validation-errors>
Your previous response did not validate. Respond again with a corrected \`\`\`json block.`;
}
