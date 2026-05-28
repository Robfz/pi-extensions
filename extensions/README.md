# extensions/

TypeScript extensions for the pi coding agent.

- **Pi scans:** `~/.pi/agent/extensions/`
- **Format:** either
  - a single `.ts` file (`extensions/<name>.ts`, for one-file extensions), or
  - a directory with an `index.ts` entry point (`extensions/<name>/index.ts`, for multi-file extensions). Sibling `.ts` files in the same directory may be imported with relative `./` paths.
- **Linking:** per-entry symlink from `~/.pi/agent/extensions/<name>{.ts,}` → this directory's entry (file or folder).
- **Build step:** none — pi loads `.ts` directly.

Add a new extension with:

```sh
# single-file
$EDITOR extensions/<name>.ts
ln -s "$PWD/extensions/<name>.ts" ~/.pi/agent/extensions/<name>.ts

# directory-form
mkdir -p extensions/<name> && $EDITOR extensions/<name>/index.ts
ln -s "$PWD/extensions/<name>" ~/.pi/agent/extensions/<name>
```

See the root [README](../README.md) for conventions (default export, doc comment, types, defensive I/O, stable status keys) and the list of installed extensions.

Reference: `docs/extensions.md` in the locally installed pi package.
