/**
 * Tests for the output-styles extension.
 *
 * Everything under test takes its inputs as arguments, so these run against temp
 * directories with no mocking: the filesystem and the config locations are the seam
 * the tests cross, the same one the extension crosses at runtime.
 *
 * Run: node --experimental-strip-types --test test/
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	applyStyle,
	claudeUserDir,
	CODING_BASE_MARKER,
	discoverStyles,
	loadStyles,
	parseStyle,
	readActiveStyle,
	styleDirs,
	writeActiveStyle,
	type StyleScope,
} from "../extensions/output-styles.ts";
import outputStyles from "../extensions/output-styles.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const temp = (): string => mkdtempSync(join(tmpdir(), "output-styles-"));

/** A scope with every location in its own throwaway directory, so a test can populate
 * just the ones it cares about and nothing leaks in from the real config. */
function scope(overrides: Partial<StyleScope> = {}): StyleScope {
	return {
		cwd: temp(),
		home: temp(),
		trusted: true,
		agentDir: temp(),
		builtinDir: join(temp(), "missing"),
		...overrides,
	};
}

function writeStyle(dir: string, file: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}

const styleMd = (name: string, body = "Be terse.", extra = ""): string =>
	`---\nname: ${name}\ndescription: ${name} style\n${extra}---\n${body}\n`;

test("parseStyle reads name and description and trims the body", () => {
	const parsed = parseStyle("---\nname: Focus\ndescription: Low load\n---\n\nBe brief.\n", "fallback");
	assert.equal(parsed.name, "Focus");
	assert.equal(parsed.description, "Low load");
	assert.equal(parsed.body, "Be brief.");
	assert.equal(parsed.keepCodingInstructions, false);
});

test("parseStyle falls back to the filename and keeps a body with no frontmatter", () => {
	const parsed = parseStyle("Just a persona.", "concise");
	assert.equal(parsed.name, "concise");
	assert.equal(parsed.body, "Just a persona.");
});

test("parseStyle reads the YAML boolean spellings, not only the literal true", () => {
	for (const spelling of ["true", "yes", "on", "True"]) {
		const parsed = parseStyle(`---\nkeep-coding-instructions: ${spelling}\n---\nB`, "x");
		assert.equal(parsed.keepCodingInstructions, true, spelling);
	}
	for (const spelling of ["false", "no", "maybe", ""]) {
		const parsed = parseStyle(`---\nkeep-coding-instructions: ${spelling}\n---\nB`, "x");
		assert.equal(parsed.keepCodingInstructions, false, spelling);
	}
});

test("parseStyle handles CRLF and a trailing YAML comment", () => {
	const parsed = parseStyle('---\r\nname: Terse\r\ndescription: "Short" # keep it short\r\n---\r\nFew words.\r\n', "x");
	assert.equal(parsed.name, "Terse");
	assert.equal(parsed.description, "Short");
	assert.equal(parsed.body, "Few words.");
});

const tail = "<project_context>CLAUDE.md</project_context>\n\nCurrent working directory: /p";
const basePrompt = `You are a coding agent.\nGuidelines here.\n${CODING_BASE_MARKER}\n\n${tail}`;
const style = (overrides: Partial<ReturnType<typeof parseStyle>> = {}) => ({
	name: "Writer",
	description: "",
	body: "You are a writing assistant.",
	keepCodingInstructions: false,
	...overrides,
});

test("applyStyle replaces the coding instructions and keeps everything after the marker", () => {
	const applied = applyStyle(basePrompt, style());
	assert.ok(!applied.includes("You are a coding agent."));
	assert.ok(applied.includes("## Output Style: Writer"));
	assert.ok(applied.includes("You are a writing assistant."));
	assert.ok(applied.includes(tail));
});

test("applyStyle appends when the style keeps the coding instructions", () => {
	const applied = applyStyle(basePrompt, style({ keepCodingInstructions: true }));
	assert.ok(applied.includes("You are a coding agent."));
	assert.ok(applied.endsWith("## Output Style: Writer\n\nYou are a writing assistant."));
});

test("applyStyle falls back to appending when the marker is absent", () => {
	const applied = applyStyle("A custom SYSTEM.md prompt.", style());
	assert.ok(applied.startsWith("A custom SYSTEM.md prompt."));
	assert.ok(applied.includes("## Output Style: Writer"));
});

test("the marker still matches the installed pi build", () => {
	// Canary: if pi rewords the tail of its prompt, replace silently degrades to append.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const source = readFileSync(join(dirname(entry), "core", "system-prompt.js"), "utf-8");
	assert.ok(source.includes(CODING_BASE_MARKER), "pi's coding-instructions tail moved; update CODING_BASE_MARKER");
});

test("styleDirs drops the project scopes when the project is untrusted", () => {
	const trusted = scope();
	const untrusted = { ...trusted, trusted: false };
	const projectDirs = (s: StyleScope): string[] => styleDirs(s).filter((dir) => dir.startsWith(s.cwd));

	writeStyle(join(trusted.cwd, ".pi", "output-styles"), "a.md", styleMd("A"));
	assert.equal(projectDirs(trusted).length, 1);
	assert.deepEqual(projectDirs(untrusted), []);
});

test("styleDirs orders ancestors outward-first so the nearest project dir wins", () => {
	const repo = temp();
	mkdirSync(join(repo, ".git"));
	const nested = join(repo, "packages", "app");
	// styleDirs drops directories that do not exist, so the ordering is only observable
	// for directories that are really there -- the same thing the runtime sees.
	const expected = [
		join(repo, ".claude", "output-styles"),
		join(repo, "packages", ".claude", "output-styles"),
		join(nested, ".claude", "output-styles"),
		join(nested, ".pi", "output-styles"),
	];
	for (const dir of expected) mkdirSync(dir, { recursive: true });

	const dirs = styleDirs(scope({ cwd: nested })).filter((dir) => dir.startsWith(repo));
	assert.deepEqual(dirs, expected);
});

test("discoverStyles lets a later directory win a name clash", () => {
	// The filesystem is the seam: populate real dirs, no mocking of the source order.
	const first = temp();
	const second = temp();
	writeStyle(first, "a.md", styleMd("Focus", "From the low-precedence dir."));
	writeStyle(second, "b.md", styleMd("Focus", "From the high-precedence dir."));
	writeStyle(first, "only.md", styleMd("Only"));

	const found = loadStyles([first, second]);
	assert.deepEqual(
		found.map((s) => [s.name, s.body]).sort(),
		[
			["Focus", "From the high-precedence dir."],
			["Only", "Be terse."],
		].sort(),
	);
});

test("discoverStyles reads a style from a populated scope and ignores non-md files", () => {
	const s = scope();
	writeStyle(join(s.agentDir, "output-styles"), "Focus.md", styleMd("Focus", "Low load."));
	writeStyle(join(s.agentDir, "output-styles"), "notes.txt", "not a style");
	const found = discoverStyles(s);
	assert.equal(found.length, 1);
	assert.equal(found[0].name, "Focus");
	assert.equal(found[0].body, "Low load.");
});

test("the active style round-trips through the state file", () => {
	const file = join(temp(), "output-styles.json");
	assert.equal(readActiveStyle(file), undefined, "a missing state file means no active style");
	assert.equal(writeActiveStyle(file, "Focus"), undefined);
	assert.equal(readActiveStyle(file), "Focus");
	writeActiveStyle(file, undefined);
	assert.equal(readActiveStyle(file), undefined);
});

test("a corrupt state file reads as no active style", () => {
	const file = join(temp(), "output-styles.json");
	writeFileSync(file, "{ not json");
	assert.equal(readActiveStyle(file), undefined);
});

test("claudeUserDir honors CLAUDE_CONFIG_DIR, including a leading tilde", () => {
	const home = temp();
	const absolute = temp();
	assert.equal(claudeUserDir(home), join(home, ".claude"));
	assert.equal(claudeUserDir(home, "   "), join(home, ".claude"));
	assert.equal(claudeUserDir(home, "~/.claude-alt"), join(home, ".claude-alt"));
	assert.equal(claudeUserDir(home, absolute), absolute);
});

test("the shipped Focus style parses as a style", () => {
	const found = discoverStyles(scope({ builtinDir: join(import.meta.dirname, "..", "styles") }));
	const focus = found.find((style) => style.name === "Focus");
	assert.ok(focus, "styles/Focus.md should ship with the package");
	assert.ok(focus.description.length > 0);
	assert.ok(focus.body.startsWith("# Focus"));
	// Focus defers to the harness, so it appends rather than replacing pi's own rules.
	assert.equal(focus.keepCodingInstructions, true);
});

/** A stand-in for pi that records what the extension registers, so the adapter can be
 * driven end to end without a running agent. */
function fakePi(): {
	pi: ExtensionAPI;
	handlers: Map<string, (event: any, ctx: any) => Promise<any>>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => { value: string }[] | null }>;
	sentMessages: string[];
} {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => { value: string }[] | null }>();
	const sentMessages: string[] = [];
	const pi = {
		on: (event: string, handler: never) => handlers.set(event, handler),
		registerCommand: (name: string, options: never) => commands.set(name, options),
		sendUserMessage: (message: string) => sentMessages.push(message),
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, sentMessages };
}

function fakeCtx(cwd: string, opts: { hasUI?: boolean; idle?: boolean } = {}) {
	const notices: string[] = [];
	return {
		cwd,
		hasUI: opts.hasUI ?? false,
		isIdle: () => opts.idle ?? true,
		isProjectTrusted: () => true,
		ui: { notify: (message: string) => notices.push(message), select: async () => undefined },
		notices,
	};
}

/** Point pi's config dir and home at throwaway directories for one test, so the real
 * user config never participates. */
async function withIsolatedEnv(agentDir: string, home: string, run: () => Promise<void>): Promise<void> {
	const keys = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"];
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("the extension applies the selected style to the next turn's system prompt", async () => {
	const agentDir = temp();
	await withIsolatedEnv(agentDir, temp(), async () => {
		writeStyle(join(agentDir, "output-styles"), "Mine.md", styleMd("Mine", "Answer in one line."));
		const { pi, handlers, commands } = fakePi();
		outputStyles(pi);
		const ctx = fakeCtx(temp());
		await handlers.get("session_start")!({}, ctx);

		// Selecting by name works headless, and persists for the next session.
		await commands.get("style")!.handler("Mine", ctx);
		assert.equal(readActiveStyle(join(agentDir, "output-styles.json")), "Mine");

		const completions = commands.get("style")!.getArgumentCompletions("mi");
		assert.deepEqual(
			completions?.map((item) => item.value),
			["Mine"],
		);

		const result = await handlers.get("before_agent_start")!({ systemPrompt: basePrompt }, ctx);
		assert.ok(result.systemPrompt.includes("Answer in one line."));
		assert.ok(!result.systemPrompt.includes("You are a coding agent."));
	});
});

test("the extension leaves the prompt alone when no style is active", async () => {
	const agentDir = temp();
	await withIsolatedEnv(agentDir, temp(), async () => {
		const { pi, handlers } = fakePi();
		outputStyles(pi);
		const ctx = fakeCtx(temp());
		await handlers.get("session_start")!({}, ctx);

		assert.equal(await handlers.get("before_agent_start")!({ systemPrompt: basePrompt }, ctx), undefined);
		assert.deepEqual(ctx.notices, []);
	});
});

test("/style reports an unknown name instead of guessing", async () => {
	const agentDir = temp();
	await withIsolatedEnv(agentDir, temp(), async () => {
		writeStyle(join(agentDir, "output-styles"), "Mine.md", styleMd("Mine"));
		const { pi, handlers, commands } = fakePi();
		outputStyles(pi);
		const ctx = fakeCtx(temp());
		await handlers.get("session_start")!({}, ctx);

		await commands.get("style")!.handler("Nope", ctx);
		const notice = ctx.notices.at(-1) ?? "";
		assert.match(notice, /Unknown output style: Nope/);
		assert.match(notice, /Mine/);
		assert.equal(readActiveStyle(join(agentDir, "output-styles.json")), undefined);
	});
});

test("/style create hands the interview to the skill message, hint included", async () => {
	const { pi, handlers, commands, sentMessages } = fakePi();
	outputStyles(pi);
	const ctx = fakeCtx(temp());
	await handlers.get("session_start")!({}, ctx);

	await commands.get("style")!.handler("create list-only replies, one bullet per idea", ctx);
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0]!, /create-output-style skill/);
	assert.match(sentMessages[0]!, /Request: list-only replies, one bullet per idea/);
	assert.deepEqual(ctx.notices, []);
});

test("/style create while the agent is busy warns and sends nothing", async () => {
	const { pi, handlers, commands, sentMessages } = fakePi();
	outputStyles(pi);
	const ctx = fakeCtx(temp(), { idle: false });
	await handlers.get("session_start")!({}, ctx);

	await commands.get("style")!.handler("create", ctx);
	assert.equal(sentMessages.length, 0);
	assert.match(ctx.notices.at(-1) ?? "", /busy/);
});

test("completions merge verbs and style names for one flat prefix surface", async () => {
	const agentDir = temp();
	await withIsolatedEnv(agentDir, temp(), async () => {
		writeStyle(join(agentDir, "output-styles"), "Code.md", styleMd("Code"));
		writeStyle(join(agentDir, "output-styles"), "Relaxed.md", styleMd("Relaxed"));
		const { pi, handlers, commands } = fakePi();
		outputStyles(pi);
		const ctx = fakeCtx(temp());
		await handlers.get("session_start")!({}, ctx);
		const completions = commands.get("style")!.getArgumentCompletions;

		const c = completions("c").map((c) => c.value);
		assert.ok(c.includes("create"));
		assert.ok(c.includes("Code")); // verb and style share the prefix
		const r = completions("r").map((c) => c.value);
		assert.ok(r.includes("Relaxed"));
		assert.ok(r.includes("reload"));
		assert.equal(completions("cr").length, 1); // deeper prefix narrows
		assert.ok(completions("").every((c) => c.value !== "create")); // bare /style keeps keywords out
	});
});
