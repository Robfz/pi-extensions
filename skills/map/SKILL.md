---
name: map
description: Map the decision space of a topic (spec, plan, exploration) through a structured interview. User-invoked only, via /map. Also the interview primitive other skills (e.g. spec) build on. Never draft an artifact until the map is complete and the user confirms.
---

Interview the user until the full decision space is mapped. Model it as a **design tree**: every decision branches into the decisions that hang off it.

## Rounds

Work in **rounds**. The **frontier** is every decision whose prerequisites are already settled. Each round: max **3 questions**, numbered **Q1, Q2, Q3**. **Findings** (new facts that change the map) follow the same discipline: numbered **F1, F2, …**, max 2 lines each, presented at the top of the round — never buried in prose. If questions + findings exceed **5 items total, split the round**. Then stop and wait.

**Do not include recommended answers.** The user answers first. Only after their answer may you challenge it — and only if you actually disagree, stating the concrete reason. If you agree, say nothing and move on.

Finding facts is your job (codebase, docs, subagents) — never ask the user for anything you can look up. Decisions are theirs — never resolve one silently. **No decision leaves the session**: if a branch's prerequisites are settled, it stays on the frontier until the user decides it. Researching its options is in-session fact-finding — never "the artifact will compare options."

## The map file

Ask for the file path in round one. The file is the tree, and the session is disposable. Update it as each round settles. Every branch is **one line** in this grammar:

```
- [settled] <decision> — <one-line rationale>
- [open] <decision> — <what's known>
- [blocked: <missing fact> | <owner>] <decision>
- [deferred] <decision> — <why, by whose call>
- [unacknowledged] <finding the user hasn't confirmed reading>
```

A finding the user did not explicitly acknowledge stays `[unacknowledged]` and may never become the premise of a later question or be treated as shared context.

## Completion

**Complete** ⇔ zero `[open]`, `[blocked]`, or `[unacknowledged]` lines. Before claiming completion, run `grep -nE '\[(open|blocked|unacknowledged)' <file>` and paste the output. If blocked branches exist, the map is **paused**, not complete: say so and list exactly what unblocks each one. Drafting from a paused map requires the user explicitly accepting each blocked branch as an open question in the artifact.

Draft only after the user confirms the map is complete or accepts its paused state.

