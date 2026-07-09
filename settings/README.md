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

Machine-local keys (e.g. `npmCommand` forcing asdf-managed Node) live only in the live `~/.pi/agent/settings.json` — the merge in `apply-settings.sh` preserves them.
| `theme` | `"dark"` | Built-in dark theme. |
| `editorPaddingX` | `1` | Small horizontal breathing room in the input editor. |
| `treeFilterMode` | `"no-tools"` | Hide tool calls in `/tree` by default; I want to see user/assistant turns, not the noise. |

Reference: `docs/settings.md` in the locally installed pi package for the full schema and every available key.
