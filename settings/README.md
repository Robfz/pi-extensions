# settings/

Curated subset of `~/.pi/agent/settings.json`.

- **Pi reads:** `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project).
- **What's here:** only the keys I deliberately set. Keys pi writes back automatically (e.g. `lastChangelogVersion`) are intentionally absent.
- **Not symlinked.** Pi mutates the live file, which would constantly dirty `git status`. Instead we merge.

## Workflow

```sh
# Push tracked keys → live settings.
scripts/apply-settings.sh
```

`apply-settings.sh` deep-merges `settings/settings.json` into `~/.pi/agent/settings.json`, preserving any other keys pi has written there. Idempotent.

If you change a setting via pi's `/settings` UI and want to keep it:

1. Open `~/.pi/agent/settings.json`, copy the new key/value.
2. Add it to `settings/settings.json` here.
3. Commit.

A `scripts/sync-settings.sh` to automate the live → repo direction (filtered to tracked keys only) is on the [TODO list](../TODO.md).

## Tracked keys

| Key | Value | Why |
|-----|-------|-----|
| `defaultProvider` | `"anthropic"` | Default model provider. |
| `defaultModel` | `"claude-fable-5"` | Preferred default model. |
| `defaultThinkingLevel` | `"high"` | I want generous thinking budget by default. |
| `theme` | `"dark"` | Built-in dark theme. |
| `editorPaddingX` | `1` | Small horizontal breathing room in the input editor. |
| `treeFilterMode` | `"no-tools"` | Hide tool calls in `/tree` by default; I want to see user/assistant turns, not the noise. |
| `packages` | `["npm:pi-web-access", "npm:pi-mcp-adapter"]` | Pi packages to auto-install; pi reconciles missing ones on startup. See `docs/packages.md`. |

**Note on `packages`:** the jq merge replaces arrays wholesale, so this list is authoritative — a package added ad-hoc via `pi install` will be dropped from the live settings on the next `apply-settings.sh`. To keep a package, add it here and commit.

## Machine-local keys

Some keys are machine-specific and deliberately **not** tracked here — they live only in the live `~/.pi/agent/settings.json`, and the merge in `apply-settings.sh` preserves them. Add them by hand on machines that need them.

### `npmCommand`

On machines where Node is managed by asdf, pi's package commands may resolve the wrong `npm`. Force the asdf-managed one (adjust the version to the local install):

```json
"npmCommand": ["env", "ASDF_NODEJS_VERSION=24.15.0", "asdf", "exec", "npm"]
```

Reference: `docs/settings.md` in the locally installed pi package for the full schema and every available key.
