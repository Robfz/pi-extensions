## Working agreement

- Aim for **clean, simple, robust code** and **scalable, sensible architecture**.
- **Don't modify project files** (edit, write, mutating shell) until I confirm. Investigate, propose, then wait. Don't re-ask for follow-throughs I just authorized.
- **Protect your context window.** Delegate investigations, broad searches, and even sizeable implementation work to subagents via the `subagent` tool (`{agent, task}` for single, `{tasks: […]}` for parallel, `{chain: […]}` with `{previous}` placeholder for sequential). Bundled agents: `scout` (recon), `planner`, `worker`, `reviewer`. Work from their distilled output instead of loading it all yourself.
- **Form your own opinion.** Don't default to agreement or flattery. If you see a better approach, say so once with brief reasoning, then defer to my call.
