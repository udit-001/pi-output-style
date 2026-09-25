# pi-output-styles

Switch how your pi agent answers with one command. A style is a markdown file — instructions only, no code — and five ready-made ones ship in the box.

## Install

```bash
pi install git:github.com/udit-001/pi-output-style   # then restart pi
```

`pi install` clones the repo into `~/.pi/agent/git/`; to pick up new styles, re-run `pi update --extensions` and restart pi. Remove it with `pi remove git:github.com/udit-001/pi-output-style`.

## What you get

- **Concise** — terse replies: result first, no preamble or narration.
- **Proactive** — starts implementing immediately, makes reasonable assumptions, asks only on destructive actions.
- **Learning** — hands you small pieces of the code to write yourself, with educational insights along the way.
- **Explanatory** — explains its implementation choices and codebase patterns as it works.
- **Focus** — answer first, one decision at a time, cheap to verify; built for attention-limited sessions.

Switch any time; the choice persists across sessions.

## Use

```
/style              picker
/style Focus        activate by name
/style off          deactivate
/style reload       re-read style files from disk
```

The active style is stored in `~/.pi/agent/output-styles.json` and reapplies on the next session. `/style <name>` works headless (`pi -p`); the picker needs interactive mode.

## Write your own

Drop a `.md` file in any style directory. Frontmatter is optional:

```markdown
---
name: Terse
description: One-line summary shown in the picker
keep-coding-instructions: true
---

# Terse

Lead with the result...
```

| Field | Meaning |
| --- | --- |
| `name` | Display name and the `/style` argument. Defaults to the filename. |
| `description` | One-line summary in the picker and completions. |
| `keep-coding-instructions` | `false` (default): replace pi's default coding prose. `true`: append the style after pi's default prompt. `yes`/`on`/`1` count as true. |

**Replace vs append.** With `keep-coding-instructions: false`, pi's default coding prose gives way to the style; project context, skills, and other extensions' additions survive either way. A style can redefine *how the agent works* without breaking tool rules.

## Where styles are read from

Lowest precedence first; a later source wins a name clash:

| Source | Scope |
| --- | --- |
| `styles/` | Ships with this package |
| `~/.pi/agent/output-styles/` | User scope |
| `$CLAUDE_CONFIG_DIR/output-styles/` (default `~/.claude`) | User scope — reuse styles you already have there |
| `<ancestor>/.claude/output-styles/` | Project, repository root down to cwd, trusted projects only |
| `<cwd>/.pi/output-styles/` | Project, trusted projects only |

Project directories load only for a trusted project: a style body is injected verbatim into the system prompt.

## Development

```bash
node scripts/link-pi.mjs .                        # junction pi into node_modules for the tests
node --experimental-strip-types --test test/      # 19 tests
```

Conventions and reasoning the code can't carry — the replace-semantics canary, the trust boundary, the test seam — live in [AGENTS.md](AGENTS.md).
