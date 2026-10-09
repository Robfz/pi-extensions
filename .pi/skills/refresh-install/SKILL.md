---
name: refresh-install
description: Bring this machine's pi installation (~/.pi/agent) back in sync with this repo — symlinks, settings, pi packages, and editor devDeps. Use after pulling changes, after a fresh clone, or when the user asks to refresh, update, or verify the local pi install.
---

# Refresh the local pi installation

Syncs `~/.pi/agent/` with this repo. Run every command from the repo root. Inspect first, report what is out of date, then fix. The user invoking this skill authorizes the fixes below; anything outside them (real-file conflicts, foreign symlinks, MCP sign-ins) is reported, not changed.

## 1. Inspect

Run these read-only checks together:

```sh
git log --oneline ORIG_HEAD..HEAD 2>/dev/null   # what the last pull brought in, if any
scripts/doctor.sh
jq .packages settings/settings.json
pi list
npm ls --depth=0                                 # non-zero exit = devDeps missing or stale
pi --version
jq .devDependencies package.json
```

Summarize the drift before fixing anything.

## 2. Fix symlinks

`scripts/link.sh` links every entry of `extensions/`, `agents/`, `skills/`, `themes/`, `prompts/`, and `workflows/` (saved workflow scripts → `~/.pi/agent/workflows/`), plus `APPEND_SYSTEM.md`. It creates and repoints links but never prunes. When an entry is renamed or deleted in the repo, doctor reports its old link as `broken:`. This also covers links directly under `~/.pi/agent/` whose repo target is gone (e.g. `mcp.json` left pointing at a file the repo no longer tracks). Remove each broken link that points into this repo:

```sh
rm ~/.pi/agent/<kind>/<name>   # or ~/.pi/agent/<name> for top-level links
scripts/link.sh
```

If a removed top-level link was a per-machine file pi still needs (such as `mcp.json`), tell the user to recreate it as a real file; don't write it yourself.

Leave `real:`, `conflict:`, and `foreign:` findings alone and report them. They need a human decision. `extensions/herdr-agent-state.ts` is managed by Herdr and doctor already skips it.

## 3. Fix settings and packages

```sh
scripts/apply-settings.sh
```

The repo's `packages` list is authoritative, but applying settings only edits the list; pi still keeps the removed packages installed. For every package in `pi list` that is not in `settings/settings.json`:

```sh
pi remove <source>
```

Packages listed in the repo but missing locally are installed by pi on its next startup.

## 4. Editor devDeps

If `npm ls --depth=0` failed:

```sh
npm install
npx tsc --noEmit
```

pi loads extensions without these packages; they only provide editor types.

If the global `pi --version` is older than the `@earendil-works/pi-*` range in `package.json`, tell the user to upgrade pi. Don't upgrade it yourself.

## 5. Verify

```sh
scripts/doctor.sh   # must print "ok"
pi list
pi mcp list
```

MCP servers are configured per machine in `~/.pi/agent/mcp.json`, which the repo doesn't manage; don't create or edit it. Report what `pi mcp list` shows. Servers that need sign-in are the user's to authenticate via `/mcp`; never touch `~/.pi/agent/mcp-auth.json`.

Finish with a short summary of what changed. If any extensions, agents, skills, workflows, or settings changed, tell the user to restart pi.
