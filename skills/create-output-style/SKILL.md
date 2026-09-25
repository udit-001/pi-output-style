---
name: create-output-style
description: Write an output style file through a short interview. Runs only via /style create or /skill:create-output-style.
disable-model-invocation: true
---

# Create an output style

Turn the user's description of how the agent should answer into a valid output style file at `~/.pi/agent/output-styles/<name>.md`.

## Interview

One question at a time, and only what the draft needs:

1. **The behavior** — "How should the agent respond? Give 2-3 examples of the reply style you want, or of replies you hate."
2. **The name** — suggest one from the behavior (lowercase, no spaces); let the user keep or change it.

Stop when a question's answer is already in hand — the invoking command's argument or an earlier turn may carry it. Then confirm the plan in one line: style name, the behavior summary, `keep-coding-instructions` choice.

## Write the file

```markdown
---
name: <name from the interview>
description: <one line, what replies look like under this style>
keep-coding-instructions: true
---

# <Name> Style

<The behavior, as rules addressed to the agent: imperative sentences, one rule per line, ordered by how often it applies.>
```

- Set `keep-coding-instructions: false` only when the user explicitly wants to replace pi's coding rules; `true` is the default for expression-only styles.
- Rules state the target behavior ("Lead with the result"), so a banned behavior stays out of the file.
- Done when: frontmatter has `name`, `description`, and `keep-coding-instructions`; the body is non-empty and carries only what shapes replies.

## Hand back

Tell the user in one line: the file path, and `/style <name>` to activate it.
