# pi-extensions

Canonical home for my custom extensions for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

pi loads extensions from `~/.pi/agent/extensions/`. This repo keeps the real source under version control, and each extension is symlinked from `~/.pi/agent/extensions/<name>.ts` into the matching file under `extensions/` here.

## Repo layout

```
.
├── extensions/         # one .ts file per extension (flat layout for now)
│   └── folder-branch.ts
├── package.json        # devDeps only: @earendil-works/pi-coding-agent for types
├── tsconfig.json       # editor-only; pi loads .ts directly, no build step
├── README.md
└── TODO.md
```

Flat layout is fine while each extension is a single file. Promote any extension to its own directory (`extensions/<name>/index.ts`) the moment it gains a second file or wants its own README.

## How an extension is wired up

Pi discovers extensions by scanning `~/.pi/agent/extensions/`. We keep that folder pointing into this repo via per-file symlinks, so:

- editing `extensions/<name>.ts` in this repo edits what pi loads;
- `git status` here is the source of truth;
- nothing in `~/.pi/agent/extensions/` is "real" — every entry there should be a symlink into this repo.

Verify with `ls -la ~/.pi/agent/extensions/`; every line should show `-> /Users/roberto/Dev/pi-extensions/extensions/...`.

## Adding a new extension

1. Create the file:
   ```sh
   $EDITOR extensions/<name>.ts
   ```
2. Symlink it into pi's extensions directory:
   ```sh
   ln -s "$PWD/extensions/<name>.ts" ~/.pi/agent/extensions/<name>.ts
   ```
3. Start a new pi session (or restart the current one) to pick it up.
4. Commit.

## Editing an existing extension

Just edit the file in `extensions/`. The symlink means pi sees the change on next session start. No build, no install step required.

If you want type-checking and autocomplete in your editor:

```sh
npm install   # pulls @earendil-works/pi-coding-agent + typescript as devDeps
```

## Removing an extension

```sh
rm ~/.pi/agent/extensions/<name>.ts   # the symlink
git rm extensions/<name>.ts
```

## Conventions

- **One default export** — a function `(pi: ExtensionAPI) => void` that registers hooks.
- **Top-of-file doc comment** describing what the extension does and which hooks it uses.
- **Types from `@earendil-works/pi-coding-agent`** — never re-declare `ExtensionAPI` / `ExtensionContext`.
- **Defensive I/O** — wrap shell calls and filesystem reads in try/catch with short timeouts; an extension that throws shouldn't break the session.
- **Stable status keys** — when using `ctx.ui.setStatus`, pick a unique string and reuse it across updates.

## Extensions

### `folder-branch`

Footer status entry that shows the current folder name and, when inside a git repo, the active branch. Refreshes on `session_start` and `turn_end` so branch switches (mine or the agent's) are reflected immediately.

## Reference

- Pi extensions docs (locally installed):
  `~/.asdf/installs/nodejs/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Other pi customization surfaces worth knowing about: `skills.md`, `themes.md`, `prompt-templates.md`, `tui.md`, `sdk.md` in the same docs folder.
