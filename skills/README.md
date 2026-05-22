# skills/

[Agent Skills](https://agentskills.io/specification) loaded by pi.

- **Pi scans:** `~/.pi/agent/skills/`
- **Format:** either
  - a directory containing a `SKILL.md` (skill name = directory name; supports nested assets/scripts), or
  - a top-level `.md` file (single-file skill, no assets).
- **Linking:** per-entry symlink from `~/.pi/agent/skills/<name>` → this directory's entry (file or folder).
- **Build step:** none.

Prefer the directory form when the skill needs scripts, examples, or more than one file. Use the single `.md` form only for trivial skills.

```sh
# directory skill
mkdir -p skills/<name> && $EDITOR skills/<name>/SKILL.md
ln -s "$PWD/skills/<name>" ~/.pi/agent/skills/<name>

# single-file skill
$EDITOR skills/<name>.md
ln -s "$PWD/skills/<name>.md" ~/.pi/agent/skills/<name>.md
```

Reference: `docs/skills.md` in the locally installed pi package.
