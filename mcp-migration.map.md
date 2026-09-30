# Map: move MCP from pi-mcp-adapter to pi's built-in MCP

Temporary working file. Delete once the plan is executed.

## Facts
- [settled] Current state — adapter v4.0.0 serves linear (from `~/.config/mcp/mcp.json`) and figma (imported from Claude Code config, never connected); built-in MCP idle (no `~/.pi/agent/mcp.json`)
- [settled] Repo touch points — adapter referenced only in `settings/settings.json` (`packages`), `settings/README.md`, root `README.md`
- [settled] Built-in `/mcp` writes exposure/enabled changes back to the defining `mcp.json`
- [settled] F3: pi docs use Figma as the `oauth.clientName` example (`{"url":"https://mcp.figma.com/mcp","oauth":{"clientName":"Claude Code"}}`); tokens stored in `~/.pi/agent/mcp-auth.json`
- [settled] F4: Figma desktop app exposes a local server at `http://127.0.0.1:3845/mcp` (no OAuth, app must be running) — alternative path
- [settled] F5: linear exposes 76 tools, ~99K chars (~25K tokens) of schemas (from adapter cache)
- [settled] F7: `--tools` is an exact-name allowlist applied before tool registration (no globs); unlisted `mcp__*` tools don't exist in that session, so `tool_search`/`codemode` can't reach them. scout/planner/reviewer have `tools:` lists (no MCP); worker has none (MCP + auto-enabled `tool_search` available)
- [settled] F8: a pi-based figma-explorer with deferred figma must list `tool_search` plus every exact `mcp__figma__<tool>` name; naming a deferred tool doesn't declare it, so it still needs one `tool_search` call (moot: figma-scout uses `excludedTools`)
- [settled] F6: pi-runner subagents pass `tools:` frontmatter as `--tools` (allowlist), so a pi-based figma-explorer must name the tool surface figma is exposed through

## Decisions
- [settled] Map file location — `./mcp-migration.map.md` at repo root, temporary
- [settled] Server scope — linear, plus figma connected directly from pi (no Claude Code gateway)
- [settled] Config location — untracked `~/.pi/agent/mcp.json`; machine-specific, not in repo
- [settled] Exposure per server — `deferred` for linear and figma; MCP work is delegated to subagents, so main context only carries the `mcp_servers` one-liner
- [settled] Linear access — worker and scout (both without a `tools:` allowlist; see mechanism below)
- [settled] Figma access — the pi-based figma agent
- [settled] Adapter leftovers — delete `mcp-adapter.json`, `mcp-cache.json*`, `mcp-onboarding.json`, `mcp-oauth/`, `~/.config/mcp/mcp.json`
- [settled] F9: exact names in `tools:` go stale when a server adds/renames tools; linear's 76 include writes/deletes (`save_*`, `delete_*`, `merge_diff`), scout is a read-only recon role
- [settled] F10: pi has `--exclude-tools` (exact-name denylist); a subagent without an allowlist keeps lazy MCP discovery. Subagent extension only maps `tools:` → `--tools` today
- [settled] F11: pi has no per-server selector in `--tools`, but the subagent extension could expand one (e.g. `mcp__linear__*`) at spawn time from the parent's `pi.getAllTools()` (reports each tool's `namespace` and `annotations`). Never stale; empty if the parent's server hasn't connected yet; `readOnlyHint` filtering unverified for linear
- [settled] MCP scope for scout and figma-scout — both get all MCP servers; per-agent restriction lives in their prompts
- [settled] F12: without an allowlist, a subagent's base set is `defaultTools` (read, bash, edit, write); grep/find/ls aren't in it (bash covers them)
- [settled] Mechanism giving scout/figma-scout all MCP tools — new exclude frontmatter field in the subagent extension → `--exclude-tools` (pi runner only), no `tools:` allowlist
- [settled] F13: pi-runner children load all extensions; without `tools:` they get defaults + MCP + `tool_search` + web tools + `subagent`
- [settled] Exclude lists — scout and figma-scout exclude `edit`, `write`, and all web tools (`web_enable`, `web_search`, `fetch_content`, `get_search_content`, `source_check`)
- [settled] F14: pi-web-access registers its tools at load but keeps them inactive; `web_enable` activates them. Naming them in `tools:` declares them directly; excluding them removes them
- [settled] New `web-scout` agent — carries the web tools that scout drops
- [settled] web-scout MCP access — yes, so it uses `excludedTools` like the other scouts instead of an allowlist
- [settled] F15: without an allowlist the web tools start inactive in the child; web-scout calls `web_enable` first; documented in its prompt
- [settled] web-scout `excludedTools` — `edit`, `write`, `subagent`; keeps all web tools
- [settled] Scout models — web-scout and scout both `claude-sonnet-5-5` (scout bumped from `claude-sonnet-5`); figma-scout stays `claude-opus-5-5`
- [settled] `subagent` — also excluded for scout and figma-scout (no nested spawning)
- [settled] Exclude field name — `excludedTools`
- [settled] Per-server `description` — none; we'd maintain it, and server names identify them
- [settled] Fate of the subagent `claude` runner — remove it if direct figma works (figma-explorer is its only user); keep if falling back
- [settled] Figma agent name — `figma-scout` (renamed from `figma-explorer`)
- [settled] Figma agent model — `claude-opus-5-5` (Opus 5.5); non-figma tools follow the mechanism decision
- [settled] Figma fallback if remote rejects pi's registration — keep the Claude Code gateway (`figma-explorer` as-is)
- [settled] Fate of `figma-explorer` if direct figma works — rewrite to run on pi and use pi's built-in MCP instead of spawning Claude Code
