// review: verified multi-angle code review of the current branch against its base.
//
// args:
//   base  string, optional. Ref to review against. Empty or missing means the repo's
//         default branch (origin/HEAD, else main, else master).
//
// The reviewed change is the working tree against `git merge-base <base> HEAD`: committed,
// uncommitted, and untracked changes. Phases: target (resolve refs and files), angles
// (6 reviewers), judge (dedupe), challenge (one adversarial reviewer per finding), verify
// (one verifier per surviving finding, isolated worktree), rules (placeholder). Returns a
// markdown report.

const SEVERITIES = ["critical", "major", "minor", "info"];
const ANGLES = {
  correctness: "logic errors, edge cases, error handling, races, broken invariants",
  security: "injection, authn/authz, secrets, unsafe input handling, path traversal, unsafe deserialization",
  performance: "algorithmic complexity, N+1 queries, blocking I/O on hot paths, memory growth, needless work",
  design: "abstractions, coupling, duplication, naming, consistency with the surrounding codebase",
  tests: "missing or weak tests for the changed behavior, tests that cannot fail, flaky patterns",
  "API compatibility": "breaking changes to public APIs, CLI flags, config, schemas, wire or file formats",
};
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

const str = { type: "string", minLength: 1 };
const severity = { type: "string", enum: SEVERITIES };
const findingProps = { title: str, file: str, line: { type: "integer", minimum: 1 }, severity, description: str, evidence: str };
const findingRequired = ["title", "file", "severity", "description", "evidence"];

const TARGET_SCHEMA = {
  type: "object",
  required: ["base", "mergeBase", "changedFiles", "untrackedFiles", "commitCount", "summary"],
  properties: {
    base: { type: "string" }, mergeBase: { type: "string" },
    changedFiles: { type: "array", items: str }, untrackedFiles: { type: "array", items: str },
    commitCount: { type: "integer", minimum: 0 }, summary: { type: "string" }, error: { type: "string" },
  },
};
const ANGLE_SCHEMA = {
  type: "object", required: ["findings"],
  properties: { findings: { type: "array", items: { type: "object", required: findingRequired, properties: findingProps } } },
};
const JUDGE_SCHEMA = {
  type: "object", required: ["findings"],
  properties: { findings: { type: "array", items: {
    type: "object", required: ["id", ...findingRequired, "angles", "merged"],
    properties: {
      id: { type: "string", pattern: "^F[1-9][0-9]*$" }, ...findingProps,
      angles: { type: "array", minItems: 1, items: { type: "string", enum: Object.keys(ANGLES) } },
      merged: { type: "integer", minimum: 1 },
    },
  } } },
};
const CHALLENGE_SCHEMA = {
  type: "object", required: ["verdict", "argument"],
  properties: { verdict: { type: "string", enum: ["stands", "refuted", "uncertain"] }, argument: str },
};
const VERIFY_SCHEMA = {
  type: "object", required: ["status", "method", "evidence", "confidence", "severity"],
  properties: {
    status: { type: "string", enum: ["verified", "not-reproduced", "inconclusive"] },
    method: str, evidence: str, confidence: { type: "number", minimum: 0, maximum: 1 }, severity,
  },
};

// Every agent() result, for the agent count, total cost, and failure list.
const results = [];
async function run(prompt, opts) {
  const r = await agent(prompt, opts);
  results.push(r);
  if (!r.ok) log(`${r.agent} [${r.label}] failed (${r.reason}): ${r.error}`);
  for (const f of r.followUps) log(`follow-up from ${r.agent} [${r.label}] (not queued): ${f.agent}: ${f.task}`);
  return r;
}

const list = (items, max = 200) =>
  items.length === 0 ? "(none)" : items.slice(0, max).map((x) => `- ${x}`).join("\n") +
    (items.length > max ? `\n- … ${items.length - max} more` : "");
const loc = (f) => (f.line ? `${f.file}:${f.line}` : f.file);
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

// ── target ──────────────────────────────────────────────────────────────────
const requestedBase = typeof args.base === "string" ? args.base.trim() : "";
const target = await phase("target", () => run(
  `Determine the review target in the current git repository. Read-only: do not fetch, checkout, commit, or modify files.
1. base: ${requestedBase ? `use \`${requestedBase}\`.` : "the default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (e.g. origin/main); if that fails, the first of main, master, origin/main, origin/master that `git rev-parse --verify` accepts."}
2. mergeBase: the full sha from \`git merge-base <base> HEAD\`.
3. changedFiles: the union of \`git diff --name-only <mergeBase>\` (working tree vs merge base, includes uncommitted changes) and untrackedFiles.
4. untrackedFiles: \`git ls-files --others --exclude-standard\`.
5. commitCount: \`git rev-list --count <mergeBase>..HEAD\`.
6. summary: 1-3 sentences on what the change does (from \`git log --oneline <mergeBase>..HEAD\` and \`git diff --stat <mergeBase>\`).
If the base or merge base cannot be resolved, set error to the reason and mergeBase to "".`,
  { schema: TARGET_SCHEMA, label: "target" },
));

function footer() {
  const failed = results.filter((r) => !r.ok);
  const cost = results.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
  return [
    failed.length ? `## Failed agents\n\n${failed.map((r) => `- ${r.agent} [${r.label}] (${r.phase}): ${r.reason}: ${cell(r.error ?? "").slice(0, 300)}`).join("\n")}\n` : "",
    `_${results.length} agents · $${cost.toFixed(4)}_`,
  ].filter(Boolean).join("\n");
}

if (!target.ok || target.data.error || !target.data.mergeBase) {
  return `# Review failed\n\nCould not resolve the review target: ${target.ok ? target.data.error || "no merge base" : target.error}\n\n${footer()}`;
}
const t = target.data;
if (t.changedFiles.length === 0) {
  return `# Review\n\nNothing to review: the working tree has no changes against ${t.base} (merge base ${t.mergeBase.slice(0, 12)}).\n\n${footer()}`;
}

// ── angles ──────────────────────────────────────────────────────────────────
const angleResults = await phase("angles", () => parallel(Object.entries(ANGLES), ([angle, focus]) => run(
  `Review a change set from one angle only: ${angle} (${focus}). Other reviewers cover the other angles, so skip issues outside yours.

Target: the working tree against merge base ${t.mergeBase} (base ${t.base}, ${t.commitCount} commits; includes uncommitted changes).
- Run \`git diff ${t.mergeBase}\` for tracked changes.
- Untracked new files (read them in full; git diff does not show them):
${list(t.untrackedFiles)}
Changed files:
${list(t.changedFiles)}
Summary: ${t.summary}

Report only issues the change introduces or makes reachable, each anchored to a file and line in the new code (omit line only if no single line applies). Evidence quotes the code or states the trigger. An empty list is a valid result.`,
  { agent: "reviewer", schema: ANGLE_SCHEMA, label: angle },
)));

const raw = [];
Object.keys(ANGLES).forEach((angle, i) => {
  if (angleResults[i].ok) for (const f of angleResults[i].data.findings) raw.push({ ...f, angle });
});
log(`angles: ${raw.length} raw findings from ${angleResults.filter((r) => r.ok).length}/${angleResults.length} reviewers`);

// ── judge ───────────────────────────────────────────────────────────────────
let findings = [];
if (raw.length > 0) {
  const judged = await phase("judge", () => run(
    `Merge and dedupe these code review findings into one list with ids F1, F2, …. The change under review is \`git diff ${t.mergeBase}\` plus untracked files. Each raw finding carries the angle that produced it; list contributing angles in "angles" and the number of raw findings merged in "merged".

${JSON.stringify(raw, null, 2)}`,
    { agent: "judge", schema: JUDGE_SCHEMA, label: "judge" },
  ));
  findings = judged.ok
    ? judged.data.findings
    : raw.map((f, i) => ({ ...f, id: `F${i + 1}`, angles: [f.angle], merged: 1 }));
  if (!judged.ok) log("judge failed: using raw findings without dedupe");
}

// ── challenge ───────────────────────────────────────────────────────────────
const challenges = await phase("challenge", () => parallel(findings, (f) => run(
  `Try to refute this code review finding. The change under review is \`git diff ${t.mergeBase}\` in the current checkout (includes uncommitted and untracked changes).

${JSON.stringify(f, null, 2)}`,
  { agent: "adversarial-reviewer", schema: CHALLENGE_SCHEMA, label: f.id },
)));

// ── verify ──────────────────────────────────────────────────────────────────
const toVerify = findings.filter((f, i) => !(challenges[i].ok && challenges[i].data.verdict === "refuted"));
const verified = await phase("verify", () => parallel(toVerify, (f) => {
  const c = challenges[findings.indexOf(f)];
  return run(
    `Verify this code review finding empirically. Your working directory is a throwaway copy of the repository that already contains the change under review (\`git diff ${t.mergeBase}\` shows it).

Finding:
${JSON.stringify(f, null, 2)}

Adversarial challenge: ${c.ok ? `${c.data.verdict}: ${c.data.argument}` : `unavailable (${c.reason})`}`,
    { agent: "verifier", schema: VERIFY_SCHEMA, label: f.id, isolation: "worktree", timeout: VERIFY_TIMEOUT_MS },
  );
}));

// ── rules ───────────────────────────────────────────────────────────────────
await phase("rules", async () => {
  log("rules: project rule checks are not implemented");
  return [];
});

// ── report ──────────────────────────────────────────────────────────────────
const rows = findings.map((f, i) => {
  const c = challenges[i];
  const vi = toVerify.indexOf(f);
  const v = vi === -1 ? undefined : verified[vi];
  const refuted = c.ok && c.data.verdict === "refuted";
  return {
    f, c, v, refuted,
    severity: v?.ok ? v.data.severity : f.severity,
    confidence: v?.ok ? v.data.confidence : undefined,
    status: v ? (v.ok ? v.data.status : `unverified (${v.reason})`) : "refuted",
  };
});
const live = rows.filter((r) => !r.refuted).sort((a, b) =>
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.confidence ?? -1) - (a.confidence ?? -1));
const refutedRows = rows.filter((r) => r.refuted);

const out = [
  `# Review: ${t.base}…working tree`,
  "",
  `Merge base \`${t.mergeBase.slice(0, 12)}\` · ${t.commitCount} commits · ${t.changedFiles.length} files (${t.untrackedFiles.length} untracked)`,
  "",
  t.summary,
  "",
  `**${live.length} findings**, ${refutedRows.length} refuted, ${angleResults.filter((r) => !r.ok).length} of ${angleResults.length} angle reviewers failed.`,
  "",
];
if (live.length) {
  out.push("| id | severity | confidence | status | location | title |", "|---|---|---|---|---|---|");
  for (const r of live) {
    out.push(`| ${r.f.id} | ${r.severity} | ${r.confidence ?? "–"} | ${r.status} | \`${cell(loc(r.f))}\` | ${cell(r.f.title)} |`);
  }
  out.push("");
}
for (const r of live) {
  const { f, c, v } = r;
  out.push(
    `## ${f.id} · ${r.severity} · ${f.title}`,
    "",
    `\`${loc(f)}\` · angles: ${f.angles.join(", ")}${f.merged > 1 ? ` · merged from ${f.merged}` : ""}${r.severity !== f.severity ? ` · reviewer severity: ${f.severity}` : ""}`,
    "",
    f.description,
    "",
    `**Evidence:** ${f.evidence}`,
    "",
    `**Challenge:** ${c.ok ? `${c.data.verdict}: ${c.data.argument}` : `failed (${c.reason})`}`,
    "",
    `**Verification:** ${v.ok ? `${v.data.status} (confidence ${v.data.confidence}): ${v.data.method}\n\n${v.data.evidence}` : `failed (${v.reason}): ${cell(v.error ?? "").slice(0, 300)}`}`,
    "",
  );
}
if (refutedRows.length) {
  out.push("## Appendix: refuted findings", "");
  for (const { f, c } of refutedRows) out.push(`- **${f.id}** ${f.severity} · \`${loc(f)}\` · ${f.title}: ${cell(c.data.argument)}`);
  out.push("");
}
out.push(footer());
return out.join("\n");
