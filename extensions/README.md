# extensions/

TypeScript extensions for the pi coding agent.

- **Pi scans:** `~/.pi/agent/extensions/`
- **Format:** one `.ts` file per extension (flat for now; promote to `<name>/index.ts` when an extension grows beyond a single file).
- **Linking:** per-file symlink from `~/.pi/agent/extensions/<name>.ts` → this directory.
- **Build step:** none — pi loads `.ts` directly.

Add a new extension with:

```sh
$EDITOR extensions/<name>.ts
ln -s "$PWD/extensions/<name>.ts" ~/.pi/agent/extensions/<name>.ts
```

See the root [README](../README.md) for conventions (default export, doc comment, types, defensive I/O, stable status keys) and the list of installed extensions.

Reference: `docs/extensions.md` in the locally installed pi package.
