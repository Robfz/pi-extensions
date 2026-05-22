# themes/

Color themes for pi's TUI.

- **Pi scans:** `~/.pi/agent/themes/*.json`
- **Format:** one `.json` file per theme; the file's stem is the theme name as seen in pi.
- **Linking:** per-file symlink from `~/.pi/agent/themes/<name>.json` → this directory.
- **Build step:** none.

```sh
$EDITOR themes/<name>.json
ln -s "$PWD/themes/<name>.json" ~/.pi/agent/themes/<name>.json
```

Reference: `docs/themes.md` in the locally installed pi package (includes the full schema and the list of semantic color keys).
