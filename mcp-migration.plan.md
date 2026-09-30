# Plan: move MCP from pi-mcp-adapter to pi's built-in MCP

Temporary working file, derived from `mcp-migration.map.md`. Delete both once executed.

## A. Repo changes (subagent: worker)
1. `extensions/subagent/agents.ts` + `index.ts`: parse `excludedTools` frontmatter (comma list, like `tools`) into `AgentConfig.excludedTools`; pi runner passes `--exclude-tools <list>`; cursor/claude runners ignore it. Document the field in `extensions/subagent/README.md` and `agents/README.md` (Format section).
2. `agents/scout.md`: drop `tools:`, add `excludedTools: edit, write, subagent, web_enable, web_search, fetch_content, get_search_content, source_check`, model `claude-sonnet-5-5`. Prompt: MCP servers (e.g. Linear) are available via `tool_search`; read-only — never call MCP tools that create, update, or delete; no file writes via bash.
3. `agents/web-scout.md` (new): model `claude-sonnet-5-5`, `excludedTools: edit, write, subagent`. Prompt: web research recon; call `web_enable` first to activate web tools; read-only as scout; MCP available via `tool_search`.
4. `agents/figma-scout.md` (new): pi runner, model `claude-opus-5-5`, same `excludedTools` as scout. Prompt: port figma-explorer's workflow/output format; load Figma tools with `tool_search` (names `mcp__figma__<tool>`); read-only; restrict itself to Figma. `figma-explorer.md` stays until step D.
5. Docs: agents table in `agents/README.md`; root `README.md` agent/runner mentions; `settings/README.md` + root `README.md` `packages` rows; `settings/settings.json` drops `npm:pi-mcp-adapter`.

## B. Machine config (main agent)
1. Write untracked `~/.pi/agent/mcp.json`: `linear` (`https://mcp.linear.app/mcp`, `exposure: deferred`), `figma` (`https://mcp.figma.com/mcp`, `oauth.clientName: "Claude Code"`, `exposure: deferred`).
2. `pi remove npm:pi-mcp-adapter` (uninstalls + edits live settings).
3. Delete `~/.pi/agent/{mcp-adapter.json,mcp-cache.json,mcp-cache.json.bak,mcp-onboarding.json,mcp-oauth/}` and `~/.config/mcp/mcp.json`.
4. User runs `pi mcp login linear` and `pi mcp login figma` (browser OAuth, interactive).

## C. Tests
1. `npx tsc --noEmit` from repo root.
2. `pi mcp list`: both servers connected, tools listed, exposure deferred.
3. Subagent runs: scout reports its tool inventory (excluded tools absent, `tool_search` present) and reads one Linear issue; web-scout runs a web search after `web_enable`; worker reads Linear; figma-scout explores a user-supplied Figma node URL.

## D. Figma outcome
- Works: delete `agents/figma-explorer.md` and the `claude` runner (types, arg building, stdin prompt, spawn branch, `processClaudeLine`, `CLAUDE_TOOL_NAME_MAP`, error messages, docs). Re-typecheck.
- Rejected: delete `agents/figma-scout.md` and the `figma` entry in `mcp.json`; keep `figma-explorer` and the `claude` runner.

## E. Review
reviewer + cross-reviewer in parallel on the full diff; fix findings; re-run C1.
