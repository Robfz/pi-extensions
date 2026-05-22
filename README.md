# pi-extensions

Custom extensions for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

The canonical copy of each extension lives in this repo under `extensions/`. pi loads extensions from `~/.pi/agent/extensions/`, so each file is symlinked from there back into this repo.

## Layout

```
extensions/
  folder-branch.ts   # footer status: current folder + git branch
```

Flat for now; switch to one-folder-per-extension if any of them grows beyond a single file.

## Adding a new extension

1. Create `extensions/<name>.ts` in this repo.
2. Symlink it into pi's extensions directory:
   ```sh
   ln -s "$PWD/extensions/<name>.ts" ~/.pi/agent/extensions/<name>.ts
   ```
3. Restart pi (or start a new session) to pick it up.

## Editing

```sh
npm install   # pulls @earendil-works/pi-coding-agent for type defs
```

Extensions are loaded directly as `.ts` by pi — no build step needed.

## Extensions

### folder-branch

Shows the current folder name in the footer, plus the active git branch when the cwd is inside a git repo. Refreshes on `session_start` and `turn_end`.
