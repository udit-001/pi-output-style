# Conventions and reasoning

What the code cannot tell you: the decisions behind it and the traps around it. Read this before changing the replace semantics, the style files, or the test seam.

## The replace-contract rides on one string in pi's prompt

`applyStyle` replaces pi's default coding instructions by finding `CODING_BASE_MARKER` — the exact last line of pi's base prompt — and cutting everything up to it. This is a contract with a foreign codebase we do not control: pi can reword its prompt at any release, and if the marker stops matching, replacement **silently degrades to append** — styles stop taking over the prompt, and nothing throws. A canary test exists precisely to turn that silent degradation into a loud red test. If it fails after a pi upgrade, the fix is one string: update the marker to pi's new last line, re-run the suite. Do not soften the marker ("just match part of the line") to make a failing test pass — it was pinned to the exact tail so that any pi reword fails loudly here instead of degrading the feature there.

## Style files: instructions, not configuration

A style body is injected verbatim into the system prompt. That is the whole feature, and it puts two rules on the shipped `styles/*.md` files:

- **Nothing executable lives there.** A style file is prose for the model — prompts, never code or shell. It must stay safe to inject from any directory a project trusts, verbatim.
- **Ground every edit in the parser, not the editor.** The `.md` + YAML-frontmatter format is parsed by `parseStyle` in `extensions/output-styles.ts`; duplicated headings, stray whitespace, or a mis-spelled `keep-coding-instructions` value all load silently. After any style edit, run the test suite (`node --experimental-strip-types --test test/`) — it parses the shipped files the way the runtime will. Frontmatter conventions: `name`, `description` (picker shows it), `keep-coding-instructions` — omit for the default `false`; all styles ship with `true`, since all styles defer to pi's coding rules and layer on expression.

## Project-scoped styles are a trust boundary

Style sources include project directories (`<cwd>/.pi/output-styles/`, ancestor `<ancestor>/.claude/output-styles/`). Because bodies are injected verbatim into the system prompt, a malicious repo could otherwise define a style that overrides your agent's behavior the moment you open it. That is why `styleDirs` gates every project-scoped source behind project trust. If you ever relax that gate — or add a new project-scoped source — that decision blows a hole in pi's trust model; surface it, do not slip it in.

## Two shapes of code, split so tests need no mocking

`extensions/output-styles.ts` separates **pure logic** (`parseStyle`, `applyStyle`, `styleDirs`, `loadStyles`, state-file read/write — everything takes its inputs as arguments, including `StyleScope` and an explicit state-file path) from **one adapter** (the default export, the only place that reads pi's context and the real environment). The seam is deliberate: tests populate real temp directories through the same arguments the runtime crosses, so no `fs` monkey-patching, no fake module systems. Keep new logic on the argument-taking side. If you find yourself reaching for `os.homedir()` or `getAgentDir()` outside that default export, move the value up into `StyleScope` instead.

## The wordless pieces

- **`scripts/link-pi.mjs` junctions pi into `node_modules`** because a locally-loaded extension has no `node_modules` of its own — pi hands it the real `@earendil-works/pi-coding-agent` at runtime, but tests have no such host. Run `node scripts/link-pi.mjs` once before running tests; it resolves the real package via npm (local install first, then `npm root -g`), so no hardcoded path lives in the script. Windows fine: it uses a junction, not a symlink, so no elevation needed.
- **Peer dependencies declare `"@earendil-works/pi-coding-agent": ">=0.79.1"` rather than bundling it** — pi supplies the module at runtime; the range pins the minimum pi whose extension API this code compiles against (import sites checked against that build).
- **State-file writes go through a temp file and rename** (`writeActiveStyle`) so a crash mid-write cannot truncate `output-styles.json`; keep that pattern for any new persisted state.
