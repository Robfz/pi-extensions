---
name: map
description: Map the decisions a stated goal depends on (spec, plan, exploration) through a structured interview with three phases (frame, rounds, cut). User-invoked only, via /map. Also the interview primitive other skills (e.g. spec) build on. Never draft an artifact until the map is complete and the user confirms.
---

Interview the user until every decision their goal depends on is settled. Model it as a **design tree**: the goal is the root, and every decision branches into the decisions that hang off it. The session has three phases: **frame**, **rounds**, **cut**.

## Frame

Round one asks only for the frame, in the user's words:

- **Q1** the goal: one sentence saying what must be true when this is done.
- **Q2** the non-goals: what is deliberately not being solved, each with its reason.
- **Q3** the limit: how big the result may be, e.g. "three PRs" or "one week".

If the goal cannot tell you whether a given branch serves it, name the ambiguous part and ask again. Only the user changes the frame afterwards.

## Rounds

Work in **rounds**. The **frontier** is every decision whose prerequisites are already settled. Each round: max **3 questions**, numbered **Q1, Q2, Q3**. **Findings** (new facts that change the map) follow the same discipline: numbered **F1, F2, …**, max 2 lines each, presented at the top of the round — never buried in prose. If questions + findings exceed **5 items total, split the round**. Then stop and wait.

**A decision or finding enters the map only if the goal cannot be met without it.** Everything else, including anything that matters only under a non-goal, you write as `[deferred]` yourself, without a question. End each round with the titles of the lines you deferred in it; the user pulls one back by naming it.

When the settled lines stop fitting the limit, say so at the top of the next round and ask what to drop before asking anything else.

**Do not include recommended answers.** The user answers first. Only after their answer may you challenge it — and only if you actually disagree, stating the concrete reason. If you agree, say nothing and move on.

Finding facts is your job (codebase, docs, subagents) — never ask the user for anything you can look up. Decisions are theirs — never resolve one silently; deferring a branch that fails the goal test is not resolving it. **No decision the goal depends on leaves the session**: if its prerequisites are settled, it stays on the frontier until the user decides it. Researching its options is in-session fact-finding — never "the artifact will compare options."

## The map file

Every map file starts with YAML frontmatter whose first key marks it as a map:

```
---
type: pi-map
---
```

Before round one, locate existing maps: `rg -l -U -g '*.md' '\A---\ntype: pi-map\n' <repo root>` (repo root, or cwd outside a git repo).

- **None found:** treat the map as a temporary artifact. Create `<topic-slug>-map.md` at the repo root without asking, and state the path in round one.
- **Maps found:** propose a path next to them, following their naming, and have the user confirm it in round one, as a fourth question.

The file is the tree, and the session is disposable. Update it as each round settles. The frame comes first, then every branch, each **one line** in this grammar:

```
- [goal] <what must be true when this is done>
- [non-goal] <what is not being solved> — <why>
- [limit] <how big the result may be>
- [settled] <decision> — <one-line rationale>
- [open] <decision> — <what's known>
- [blocked: <missing fact> | <owner>] <decision>
- [deferred] <decision or finding> — <why, by whose call>
- [unacknowledged] <finding the user hasn't confirmed reading>
```

A finding the user did not explicitly acknowledge stays `[unacknowledged]` and may never become the premise of a later question or be treated as shared context.

## Cut

When no `[open]`, `[blocked]` or `[unacknowledged]` lines remain, run the cut. Spawn a subagent that receives only the map file, with no session history. It returns, for each `[settled]` line, the goal clause it serves (directly, or as a prerequisite of a line that does) or `none`, plus the total size measured against the limit.

Present the result as one round: the `none` lines, which become `[deferred]` unless the user keeps them, and, if the total exceeds the limit, the question of what to drop.

**The cut only removes or defers.** Neither you nor the subagent adds branches or findings during it. Any review of a map, by you or by subagents, asks only two things: is a goal clause left unmet by the settled lines, and do two settled lines contradict each other.

## Completion

**Complete** ⇔ zero `[open]`, `[blocked]`, or `[unacknowledged]` lines, and the cut has run since the last change. Before claiming completion, run `grep -nE '\[(open|blocked|unacknowledged)' <file>` and paste the output. If blocked branches exist, the map is **paused**, not complete: say so and list exactly what unblocks each one. Drafting from a paused map requires the user explicitly accepting each blocked branch as an open question in the artifact.

Draft only after the user confirms the map is complete or accepts its paused state.
