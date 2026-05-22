# prompts/

Prompt templates loaded by pi.

- **Pi scans:** `~/.pi/agent/prompts/*.md`
- **Format:** one `.md` file per template; the file's stem is the template name.
- **Linking:** per-file symlink from `~/.pi/agent/prompts/<name>.md` → this directory.
- **Build step:** none.

Directory is named `prompts/` (not `prompt-templates/`) to match the upstream path 1:1, so the symlink mapping is trivial.

```sh
$EDITOR prompts/<name>.md
ln -s "$PWD/prompts/<name>.md" ~/.pi/agent/prompts/<name>.md
```

Reference: `docs/prompt-templates.md` in the locally installed pi package.
