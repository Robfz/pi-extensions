---
name: prose-hygiene
description: Audit and clean code comments and documentation (READMEs, docs, docstrings) that narrate edit history instead of describing current behavior ("now uses Y instead of X", "removed the fallback", "previously we..."). Use when the user asks to clean up comments or docs, strip change narration, remove AI slop, or review comment/doc quality in a diff or file. Prose-only changes — never touches code logic.
---

# Prose Hygiene

Comments and documentation describe the **current state** — for comments, current code plus **non-obvious why**. Git owns history. Prose that only makes sense relative to a past version, a conversation, or a review is rot — delete it.

## Scope

- Covers code comments, docstrings, and documentation files (README, docs/, guides).
- Default to the current diff (`git diff`, staged, or a named commit/branch range). Only sweep whole files when explicitly asked.
- Modify prose only. Never change code logic, even trivially. If a comment or doc reveals a code problem, report it — don't fix it.

## Delete

- **Change narration:** "now uses Y instead of X", "changed to", "updated to", "no longer", "removed the fallback", "renamed from".
- **References to prior versions:** "previously", "the old implementation", "was X before".
- **Conversation/review artifacts:** "as requested", "per feedback", "fixes the issue above", references to review findings or ticket discussion that don't stand alone.
- **Code restatement:** comments that paraphrase the next line in English ("increment the counter", "loop over users").
- **In-motion notes:** "TODO: implement" above implemented code, stub markers left behind, "for now" that describes the permanent state.
- **Doc-file narration:** "we recently migrated to", "new in this version", "this section was updated" in READMEs or guides that aren't changelogs.

## Keep (and don't rewrite gratuitously)

- **Standalone why:** invariants, workarounds for upstream bugs, ordering dependencies, performance tricks, legal/compliance notes, deprecation timelines.
- **Salvageable why:** if a narrating comment contains a real reason, rewrite it as a present-tense fact. "Uses Y instead of X because Z" → "Uses Y because Z" (only if Z is non-obvious and durable).
- **Doc contracts:** JSDoc/docstrings documenting parameters, returns, and errors for public APIs — fix them only if they narrate history.
- **History-by-design artifacts:** changelogs, release notes, migration guides, ADRs. Narrating change is their job — leave them alone.
- Anything you're unsure about. When in doubt, keep and flag it in the summary instead of deleting.

## The test

For each comment or doc passage ask: *would this sentence make sense to a reader who has only the current code and docs, with no access to git history, the PR, or any conversation?* If no — delete or rewrite as a present-tense fact.

## Output

After editing, give a short summary: passages deleted (count + representative examples), passages rewritten (before → after), and anything kept-but-flagged.
