// implement: implement a spec in the current checkout, then review, challenge and fix it until clean.
//
// args:
//   spec       string, required. What to build: requirements, decisions, constraints.
//   checks     string, optional. Shell command that must pass (e.g. "pnpm check && pnpm test").
//              Missing means preflight detects one from the project (empty if none found).
//   rules      string, optional. Directory of rule files (ADR-like markdown, one decision per
//              file), relative to the current directory. Default ".agents/rules"; a missing
//              directory means no rules. Files with `status: superseded` frontmatter are skipped.
//   verify     "none" | "major" | "all", optional, default "none". Which surviving findings a
//              `verifier` reproduces in a throwaway worktree before they are fixed: none,
//              critical and major only, or all. Not-reproduced findings are not fixed.
//   maxRounds  integer 1-10, optional, default 5. Review rounds; fixes run between rounds, so
//              every fix is reviewed and the last round's surviving findings are reported, not fixed.
//
// Requires a clean working tree: the change under review is everything since the starting HEAD.
// Writes in the checkout, one writer at a time; never commits. Phases: preflight, implement,
// then per round: review (one rule-reviewer per rule + 7 angle reviewers), judge (dedupe),
// challenge (one adversarial reviewer per finding), verify (optional), fix (every surviving
// finding); then audit (deviations from the spec) and final checks. Returns a markdown report
// that leads with follow-ups: important deviations from the spec, findings that couldn't be
// fixed or were still open after the last round, failed reviewers, and failing checks.

const SEVERITIES = ["critical", "major", "minor", "info"];
const ANGLES = {
  spec: "the change does everything the spec asks and nothing it doesn't: missing or partial requirements, behavior the spec didn't ask for, decisions that contradict the spec",
  correctness: "logic errors, edge cases, error handling, races, broken invariants",
  security: "injection, authn/authz, secrets, unsafe input handling, path traversal, unsafe deserialization",
  performance: "algorithmic complexity, N+1 queries, blocking I/O on hot paths, memory growth, needless work",
  design: "abstractions, coupling, duplication, naming, consistency with the surrounding codebase, comments that narrate history instead of explaining non-obvious whys",
  tests: "missing or weak tests for the changed behavior, tests that cannot fail, flaky patterns",
  "API compatibility": "breaking changes to public APIs, CLI flags, config, schemas, wire or file formats",
};
const MIN = 60_000;
const TIMEOUT = { preflight: 5 * MIN, implement: 45 * MIN, review: 20 * MIN, judge: 15 * MIN, challenge: 15 * MIN, verify: 15 * MIN, fix: 45 * MIN, audit: 20 * MIN, final: 15 * MIN };

// ── args ────────────────────────────────────────────────────────────────────
const spec = typeof args.spec === "string" ? args.spec.trim() : "";
const requestedChecks = typeof args.checks === "string" ? args.checks.trim() : "";
const rulesDir = typeof args.rules === "string" && args.rules.trim() ? args.rules.trim() : ".agents/rules";
const verifyMode = args.verify ?? "none";
const maxRounds = args.maxRounds ?? 5;
const argError = !spec ? "`spec` is required"
  : !["none", "major", "all"].includes(verifyMode) ? "`verify` must be \"none\", \"major\" or \"all\""
  : !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10 ? "`maxRounds` must be an integer from 1 to 10"
  : "";
if (argError) return `# Implement failed\n\nInvalid args: ${argError}.`;

// ── schemas ─────────────────────────────────────────────────────────────────
const str = { type: "string", minLength: 1 };
const strList = { type: "array", items: str };
const severity = { type: "string", enum: SEVERITIES };
const findingProps = { title: str, file: str, line: { type: "integer", minimum: 1 }, severity, description: str, evidence: str };
const findingRequired = ["title", "file", "severity", "description", "evidence"];
const findingList = { type: "array", items: { type: "object", required: findingRequired, properties: findingProps } };
const deviationList = {
  type: "array",
  items: { type: "object", required: ["what", "why"], properties: { what: str, why: str } },
};

const PREFLIGHT_SCHEMA = {
  type: "object", required: ["head", "branch", "dirty", "checks", "rules"],
  properties: {
    head: { type: "string" }, branch: { type: "string" }, dirty: strList, checks: { type: "string" },
    rules: { type: "array", items: { type: "object", required: ["path", "title"], properties: { path: str, title: str } } },
    error: { type: "string" },
  },
};
const IMPLEMENT_SCHEMA = {
  type: "object", required: ["summary", "filesChanged", "checksPass", "deviations"],
  properties: { summary: str, filesChanged: strList, checksPass: { type: "boolean" }, checksOutput: { type: "string" }, deviations: deviationList },
};
const ANGLE_SCHEMA = { type: "object", required: ["findings"], properties: { findings: findingList } };
const RULE_SCHEMA = { type: "object", required: ["applies", "findings"], properties: { applies: { type: "boolean" }, findings: findingList } };
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
const FIX_SCHEMA = {
  type: "object", required: ["outcomes", "checksPass", "deviations"],
  properties: {
    outcomes: { type: "array", items: {
      type: "object", required: ["id", "status", "note"],
      properties: { id: str, status: { type: "string", enum: ["fixed", "cannot-fix"] }, note: str },
    } },
    checksPass: { type: "boolean" }, checksOutput: { type: "string" }, deviations: deviationList,
  },
};
const AUDIT_SCHEMA = {
  type: "object", required: ["deviations"],
  properties: { deviations: { type: "array", items: {
    type: "object", required: ["what", "why", "importance"],
    properties: { what: str, why: str, importance: { type: "string", enum: ["important", "minor"] } },
  } } },
};
const FINAL_SCHEMA = {
  type: "object", required: ["checksRun", "pass", "output", "files"],
  properties: { checksRun: { type: "boolean" }, pass: { type: "boolean" }, output: { type: "string" }, files: strList },
};

// ── helpers ─────────────────────────────────────────────────────────────────
// Every agent() result, for the agent count, total cost, and failure list.
const results = [];
async function run(prompt, opts) {
  const r = await agent(prompt, opts);
  results.push(r);
  if (!r.ok) log(`${r.agent} [${r.label}] failed (${r.reason}): ${r.error}`);
  for (const f of r.followUps) log(`follow-up from ${r.agent} [${r.label}] (not queued): ${f.agent}: ${f.task}`);
  return r;
}

const list = (items) => (items.length === 0 ? "(none)" : items.map((x) => `- ${x}`).join("\n"));
const loc = (f) => (f.line ? `${f.file}:${f.line}` : f.file);
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const oneLine = (f) => `**${f.id}** ${f.severity} · \`${loc(f)}\` · ${f.title}`;
const specBlock = `<spec>\n${spec}\n</spec>`;
const houseRules = `House rules:
- Never commit, stash, switch branches, or push.
- Clean, simple code that matches the surrounding codebase. No speculative machinery.
- Comments only for non-obvious whys, describing the current state. Never narrate changes or history.`;

function footer() {
  const failed = results.filter((r) => !r.ok);
  const cost = results.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
  return [
    failed.length ? `## Failed agents\n\n${failed.map((r) => `- ${r.agent} [${r.label}] (${r.phase}): ${r.reason}: ${cell(r.error ?? "").slice(0, 300)}`).join("\n")}\n` : "",
    `_${results.length} agents · $${cost.toFixed(4)}_`,
  ].filter(Boolean).join("\n");
}
const stopped = (title, body) => `# Implement stopped: ${title}\n\n${body}\n\n${footer()}`;

// ── preflight ───────────────────────────────────────────────────────────────
const pre = await phase("preflight", () => run(
  `Inspect the current git repository before an automated implementation run. Read-only: do not modify, fetch, checkout, or commit anything.
1. head: the full sha from \`git rev-parse HEAD\`. branch: \`git branch --show-current\` (empty when detached).
2. dirty: the lines of \`git status --porcelain\` (at most 20). Empty means the working tree is clean.
3. checks: ${requestedChecks ? `use exactly \`${requestedChecks}\`.` : "detect one shell command that typechecks, lints and tests the project, from package.json scripts, a Makefile, pyproject.toml, Cargo.toml or similar, joining several with &&. Prefer an existing aggregate script (e.g. `check`, `ci`) plus the test script. Empty if the project has none. Do not run it."}
4. rules: every \`*.md\` file under \`${rulesDir}\` (recursively, paths relative to the current directory), except README.md files and files whose YAML frontmatter has \`status: superseded\`. title: the file's first heading, else its file name. An empty list if the directory doesn't exist.
If this is not a git repository, set error to the reason.`,
  { agent: "scout", schema: PREFLIGHT_SCHEMA, label: "preflight", timeout: TIMEOUT.preflight },
));
if (!pre.ok) return stopped("preflight failed", `${pre.reason}: ${pre.error}`);
const { head, branch, dirty, checks, rules } = pre.data;
if (pre.data.error || !head) return stopped("not a git repository", pre.data.error || "no HEAD");
if (dirty.length > 0) {
  return stopped("working tree not clean", `Commit or stash these first, so the review covers only this run's changes:\n\n\`\`\`\n${dirty.join("\n")}\n\`\`\``);
}
log(`preflight: ${branch || "detached"} @ ${head.slice(0, 12)} · checks: ${checks || "(none)"} · ${rules.length} rules`);

const changeTarget = `The change under review is the working tree against ${head}: run \`git diff ${head}\` for tracked changes, and \`git ls-files --others --exclude-standard\` for new untracked files (read those in full; git diff does not show them).`;
const checksLine = checks
  ? `Checks: \`${checks}\`. Run them before you finish and keep going until they pass.`
  : "The project has no check command; run whatever tests cover your change.";
const rulesLine = rules.length
  ? `Project rules the code must follow (read the relevant ones before you start):\n${list(rules.map((r) => `${r.path}: ${r.title}`))}`
  : "";

// ── implement ───────────────────────────────────────────────────────────────
const deviations = []; // {what, why, by}
const impl = await phase("implement", () => run(
  `Implement this spec in the current checkout.

${specBlock}

${checksLine}
${rulesLine}

${houseRules}

Deviations: record every place your implementation departs from, narrows, extends, or interprets the spec (an ambiguity you resolved, a requirement you couldn't meet, an approach the spec didn't choose), each with the reason.`,
  { agent: "worker", schema: IMPLEMENT_SCHEMA, label: "implement", timeout: TIMEOUT.implement },
));
if (!impl.ok) return stopped("implementation failed", `${impl.reason}: ${impl.error}\n\n${impl.output}`);
deviations.push(...impl.data.deviations.map((d) => ({ ...d, by: "implement" })));
if (checks && !impl.data.checksPass) {
  return stopped("checks fail after implementation", `${impl.data.summary}\n\n\`\`\`\n${impl.data.checksOutput ?? ""}\n\`\`\``);
}

// ── review rounds ───────────────────────────────────────────────────────────
// history: every judged finding with its outcome: refuted, not-reproduced, fixed, cannot-fix, unreported, open.
const history = [];
const rounds = []; // per-round stats for the report
const reviewers = [
  ...rules.map((r) => ({ kind: "rule", source: r.path, label: `rule: ${r.path.split("/").pop()}`, rule: r })),
  ...Object.entries(ANGLES).map(([angle, focus]) => ({ kind: "angle", source: angle, label: angle, focus })),
];
const sources = reviewers.map((r) => r.source);
const JUDGE_SCHEMA = {
  type: "object", required: ["findings"],
  properties: { findings: { type: "array", items: {
    type: "object", required: ["id", ...findingRequired, "sources", "merged"],
    properties: {
      id: { type: "string", pattern: "^F[1-9][0-9]*$" }, ...findingProps,
      sources: { type: "array", minItems: 1, items: { type: "string", enum: sources } },
      merged: { type: "integer", minimum: 1 },
    },
  } } },
};

let cleanRound = 0;
for (let round = 1; round <= maxRounds; round++) {
  const stats = { round, raw: 0, findings: 0, refuted: 0, notReproduced: 0, fixed: 0, cannotFix: 0, open: 0, rulesApplied: 0, failedReviewers: [] };
  rounds.push(stats);

  const reviews = await phase(`review ${round}`, () => parallel(reviewers, (rv) => run(
    rv.kind === "rule"
      ? `Check this change against one project rule: \`${rv.rule.path}\` (${rv.rule.title}).

${changeTarget}

For context, the change implements this spec:
${specBlock}`
      : `Review a change from one angle only: ${rv.source} (${rv.focus}). Other reviewers cover the other angles, so skip issues outside yours.

${changeTarget}

The change implements this spec:
${specBlock}

Report only issues the change introduces or makes reachable, each anchored to a file and line in the new code (omit line only if no single line applies). Evidence quotes the code or states the trigger. An empty list is a valid result.`,
    { agent: rv.kind === "rule" ? "rule-reviewer" : "reviewer", schema: rv.kind === "rule" ? RULE_SCHEMA : ANGLE_SCHEMA, label: `${rv.label} (r${round})`, timeout: TIMEOUT.review },
  )));

  const raw = [];
  reviews.forEach((r, i) => {
    if (!r.ok) {
      stats.failedReviewers.push(reviewers[i].source);
      return;
    }
    if (reviewers[i].kind === "rule" && r.data.applies) stats.rulesApplied++;
    for (const f of r.data.findings) raw.push({ ...f, source: reviewers[i].source });
  });
  stats.raw = raw.length;
  log(`review ${round}: ${raw.length} raw findings · ${stats.rulesApplied}/${rules.length} rules apply · ${stats.failedReviewers.length} reviewers failed`);
  if (raw.length === 0) { cleanRound = round; break; }

  // ── judge
  // Open and unreported findings aren't settled, so a reviewer raising them again is signal.
  const prior = history.filter((h) => h.outcome !== "open" && h.outcome !== "unreported");
  const judged = await phase(`judge ${round}`, () => run(
    `Merge and dedupe these code review findings into one list with ids F1, F2, …. ${changeTarget} Each raw finding carries the source that produced it (a review angle or a rule file); list contributing sources in "sources" and the number of raw findings merged in "merged".
${prior.length ? `
Earlier rounds already handled these findings. Drop any raw finding that repeats one of them, unless it brings new evidence: a refuted finding with a new trigger path, or a fixed finding whose fix is wrong or incomplete.
${JSON.stringify(prior.map(({ title, file, line, outcome, note }) => ({ title, file, line, outcome, note })), null, 2)}
` : ""}
Raw findings:
${JSON.stringify(raw, null, 2)}`,
    { agent: "judge", schema: JUDGE_SCHEMA, label: `judge (r${round})`, timeout: TIMEOUT.judge },
  ));
  const findings = (judged.ok
    ? judged.data.findings
    : raw.map((f, i) => ({ ...f, id: `F${i + 1}`, sources: [f.source], merged: 1 }))
  ).map((f) => ({ ...f, id: `R${round}-${f.id}` }));
  if (!judged.ok) log(`judge ${round} failed: using raw findings without dedupe`);
  stats.findings = findings.length;
  if (findings.length === 0) { cleanRound = round; break; }

  // ── challenge
  const challenges = await phase(`challenge ${round}`, () => parallel(findings, (f) => run(
    `Try to refute this code review finding. ${changeTarget}

${JSON.stringify(f, null, 2)}`,
    { agent: "adversarial-reviewer", schema: CHALLENGE_SCHEMA, label: f.id, timeout: TIMEOUT.challenge },
  )));
  const challengeText = (i) => (challenges[i].ok ? `${challenges[i].data.verdict}: ${challenges[i].data.argument}` : `unavailable (${challenges[i].reason})`);
  let surviving = [];
  findings.forEach((f, i) => {
    if (challenges[i].ok && challenges[i].data.verdict === "refuted") {
      history.push({ ...f, round, outcome: "refuted", note: challenges[i].data.argument });
      stats.refuted++;
    } else surviving.push({ ...f, challenge: challengeText(i) });
  });

  // ── verify (optional)
  const toVerify = verifyMode === "all" ? surviving
    : verifyMode === "major" ? surviving.filter((f) => f.severity === "critical" || f.severity === "major")
    : [];
  if (toVerify.length > 0) {
    const verdicts = await phase(`verify ${round}`, () => parallel(toVerify, (f) => run(
      `Verify this code review finding empirically. Your working directory is a throwaway copy of the repository that already contains the change under review (\`git diff ${head}\` shows it).

Finding:
${JSON.stringify(f, null, 2)}`,
      { agent: "verifier", schema: VERIFY_SCHEMA, label: f.id, isolation: "worktree", timeout: TIMEOUT.verify },
    )));
    toVerify.forEach((f, i) => {
      const v = verdicts[i];
      if (v.ok && v.data.status === "not-reproduced") {
        history.push({ ...f, round, outcome: "not-reproduced", note: v.data.method });
        stats.notReproduced++;
        surviving = surviving.filter((s) => s !== f);
      } else {
        f.verification = v.ok ? `${v.data.status} (confidence ${v.data.confidence}): ${v.data.method}\n${v.data.evidence}` : `unavailable (${v.reason})`;
        if (v.ok) f.severity = v.data.severity;
      }
    });
  }
  if (surviving.length === 0) { cleanRound = round; break; }

  // The last round's survivors are reported, not fixed, so every fix gets reviewed.
  if (round === maxRounds) {
    for (const f of surviving) history.push({ ...f, round, outcome: "open", note: f.challenge });
    stats.open = surviving.length;
    break;
  }

  // ── fix
  const fix = await phase(`fix ${round}`, () => run(
    `Fix every one of these code review findings in the current checkout. They survived an adversarial challenge, so treat them as real. ${changeTarget}

The change implements this spec:
${specBlock}

Findings:
${JSON.stringify(surviving, null, 2)}

For each finding report "fixed", or "cannot-fix" only when fixing it would contradict the spec or another finding, or is impossible; say why in the note.
${checksLine}
${rulesLine}

${houseRules}

Deviations: record every place your fixes make the implementation depart further from the spec, each with the reason. Empty if none.`,
    { agent: "worker", schema: FIX_SCHEMA, label: `fix (r${round})`, timeout: TIMEOUT.fix },
  ));
  if (!fix.ok) {
    for (const f of surviving) history.push({ ...f, round, outcome: "open", note: `fix step failed: ${fix.reason}` });
    stats.open = surviving.length;
    break;
  }
  deviations.push(...fix.data.deviations.map((d) => ({ ...d, by: `fix ${round}` })));
  for (const f of surviving) {
    const o = fix.data.outcomes.find((x) => x.id === f.id);
    // An unreported finding isn't escalated: the next review round checks the code again.
    history.push({ ...f, round, outcome: o ? o.status : "unreported", note: o ? o.note : "the fixer did not report on it" });
    if (o?.status === "fixed") stats.fixed++;
    if (o?.status === "cannot-fix") stats.cannotFix++;
  }
  if (checks && !fix.data.checksPass) {
    log(`fix ${round}: checks fail; stopping the review loop`);
    break;
  }
}

// ── audit ───────────────────────────────────────────────────────────────────
const audit = await phase("audit", () => run(
  `Audit how the final implementation in the current checkout departs from its spec. ${changeTarget}

${specBlock}

The implementer and fixers recorded these deviations:
${deviations.length ? JSON.stringify(deviations, null, 2) : "(none)"}

Check each recorded deviation against the code: drop it if the code no longer departs from the spec, otherwise keep it (rewrite "what" to match the final code if needed). Then compare the code with the spec yourself and add every unrecorded deviation, including spec requirements the code doesn't meet. Classify each:
- important: changes a behavior, interface, data or file format, or design decision the spec chose, or leaves a spec requirement unmet.
- minor: an implementation detail within the spec's intent.
An empty list is a valid result.`,
  { agent: "reviewer", schema: AUDIT_SCHEMA, label: "audit", timeout: TIMEOUT.audit },
));
// Without an audit, every recorded deviation is escalated rather than silently classified.
const auditedDeviations = audit.ok
  ? audit.data.deviations
  : deviations.map((d) => ({ what: d.what, why: `${d.why} (${d.by}; unaudited)`, importance: "important" }));

// ── final checks ────────────────────────────────────────────────────────────
const final = await phase("final", () => run(
  `In the current directory, ${checks ? `run \`${checks}\`` : "there is no check command, so run nothing"} and \`git status --porcelain\`. Do not modify any files.
- checksRun: whether you ran a check command. pass: whether it exited 0 (true when nothing ran).
- output: the relevant failure output (≤ 40 lines), or a one-line summary when it passed.
- files: the paths \`git status --porcelain\` lists.`,
  { agent: "general", schema: FINAL_SCHEMA, label: "final checks", timeout: TIMEOUT.final },
));

// ── report ──────────────────────────────────────────────────────────────────
const byOutcome = (o) => history.filter((h) => h.outcome === o);
const important = auditedDeviations.filter((d) => d.importance === "important");
const minor = auditedDeviations.filter((d) => d.importance === "minor");
const cannotFix = byOutcome("cannot-fix");
const open = byOutcome("open");
const failedRounds = rounds.filter((r) => r.failedReviewers.length > 0);
const checksFail = !final.ok || (final.data.checksRun && !final.data.pass);

const followUps = [
  ...important.map((d) => `- **Deviation:** ${d.what} — ${d.why}`),
  ...cannotFix.map((f) => `- **Cannot fix:** ${oneLine(f)} — ${f.note}`),
  ...open.map((f) => `- **Open:** ${oneLine(f)} — ${f.note}`),
  ...failedRounds.map((r) => `- **Unreviewed:** round ${r.round}: ${r.failedReviewers.length} reviewer(s) failed: ${r.failedReviewers.join(", ")}`),
  ...(checksFail ? [`- **Checks fail:** ${final.ok ? final.data.output : `final check agent failed (${final.reason})`}`] : []),
];

const firstLine = spec.split("\n")[0];
const title = firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine;
const lastRound = rounds.length;
const status = cleanRound ? `clean after ${cleanRound} review round${cleanRound > 1 ? "s" : ""}`
  : open.length ? `stopped after ${lastRound} round${lastRound > 1 ? "s" : ""} with ${open.length} open finding${open.length > 1 ? "s" : ""}`
  : `stopped after ${lastRound} round${lastRound > 1 ? "s" : ""}`;
const files = final.ok ? final.data.files : impl.data.filesChanged;

const out = [
  `# Implement: ${title}`,
  "",
  `${branch || "detached"} @ \`${head.slice(0, 12)}\` · ${status} · checks: ${!checks ? "none" : checksFail ? "**fail**" : "pass"} · ${rules.length} rules`,
  "",
  "## Follow-ups",
  "",
  followUps.length ? followUps.join("\n") : "None.",
  "",
  "## Summary",
  "",
  impl.data.summary,
  "",
  "## Files changed",
  "",
  list(files.map((f) => `\`${f}\``)),
  "",
  "## Review rounds",
  "",
  "| round | raw | findings | refuted | not reproduced | fixed | cannot fix | open | rules applied |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rounds.map((r) => `| ${r.round} | ${r.raw} | ${r.findings} | ${r.refuted} | ${r.notReproduced} | ${r.fixed} | ${r.cannotFix} | ${r.open} | ${r.rulesApplied}/${rules.length} |`),
  "",
];
const fixed = byOutcome("fixed");
if (fixed.length) out.push("### Fixed", "", ...fixed.map((f) => `- ${oneLine(f)} (${f.sources.join(", ")})`), "");
const unreported = byOutcome("unreported");
if (unreported.length) out.push("### Not reported by the fixer", "", ...unreported.map((f) => `- ${oneLine(f)} (${f.sources.join(", ")})`), "");
if (minor.length) out.push("## Minor deviations", "", ...minor.map((d) => `- ${d.what} — ${d.why}`), "");
const dropped = [...byOutcome("refuted"), ...byOutcome("not-reproduced")];
if (dropped.length) out.push("## Appendix: refuted and not reproduced", "", ...dropped.map((f) => `- ${oneLine(f)} (${f.outcome}): ${cell(f.note)}`), "");
out.push(footer());
return out.join("\n");
