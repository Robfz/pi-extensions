---
description: Verified multi-angle review of this branch against its base (saved review workflow)
argument-hint: "[base-branch]"
---
Run the saved `review` workflow: call the spawn tool with `{ "workflow": "review", "args": { "base": "${1:-}" } }`. An empty base means the repo's default branch. Don't review anything yourself first.

When it returns, show me the report unchanged, then add at most five lines of your own take.
