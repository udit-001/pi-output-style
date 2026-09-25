/**
 * Output Styles
 *
 * Claude Code output styles in pi: markdown files with YAML frontmatter whose body
 * shapes how the agent answers. Follows Claude's semantics, as pi-code implements them.
 *
 * Frontmatter:
 *   name: Focus                     defaults to the filename
 *   description: one-line summary   shown in the picker
 *   keep-coding-instructions: false replace pi's default coding prose (default)
 *                             true  append the style after the default prompt
 *
 * Replace semantics: pi's default coding instructions are excised up to the last line
 * of pi's base prompt, so the append text, project context, skills, cwd, and other
 * extensions' additions all survive. When that marker is absent (a custom SYSTEM.md),
 * the style falls back to appending.
 *
 * Style locations, lowest precedence first (a later source wins a name clash):
 *   <builtinDir>        styles shipped beside this extension
 *   <agentDir>/output-styles/           pi user scope
 *   <claudeDir>/output-styles/          Claude user scope
 *   <ancestor>/.claude/output-styles/   project, repo root -> cwd, trusted only
 *   <cwd>/.pi/output-styles/            project, trusted only
 *
 * Usage:
 *   /style                 picker
 *   /style Focus           activate by name
 *   /style off             deactivate
 *   /style reload          re-read style files from disk
 *
 * The active style persists in <agentDir>/output-styles.json.
 *
 * Layout: the pure and filesystem-facing parts take everything they need as arguments
 * (StyleScope, an explicit state file path), so they are testable against a temp dir
 * with no mocking. The default export is the adapter that reads pi's context and wires
 * them to events and the /style command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export interface OutputStyle {
	name: string;
	description: string;
	body: string;
	keepCodingInstructions: boolean;
}

/** Where a style lookup runs: the directories a user's config can live in, plus the
 * trust decision that gates the project-scoped ones. Plain data, so callers and tests
 * cross the same seam. */
export interface StyleScope {
	/** Session working directory; project styles are read from here upward. */
	cwd: string;
	/** Home directory, for the user-scope Claude config directory. */
	home: string;
	/** Project-scoped styles are injected verbatim into the system prompt, so they
	 * load only for a trusted project. */
	trusted: boolean;
	/** pi's agent directory, e.g. ~/.pi/agent. */
	agentDir: string;
	/** Styles shipped with this package. */
	builtinDir: string;
	/** The value of CLAUDE_CONFIG_DIR, if set; empty or absent means ~/.claude. */
	claudeConfigDir?: string;
}

/** The last line of pi's default coding instructions. Everything after it -- append
 * text, project context, skills, cwd, other extensions' additions -- survives a style
 * replacement. A canary test pins this against the installed pi build. */
export const CODING_BASE_MARKER =
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

/** YAML boolean spellings, so `keep-coding-instructions: yes` means what its author meant. */
function isTrue(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	return ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());
}

function field(frontmatter: Record<string, unknown>, key: string): string {
	const value = frontmatter[key];
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

export function parseStyle(content: string, fallbackName: string): OutputStyle {
	const { frontmatter, body } = parseFrontmatter(content);
	return {
		name: field(frontmatter, "name") || fallbackName,
		description: field(frontmatter, "description"),
		body: body.trim(),
		keepCodingInstructions: isTrue(frontmatter["keep-coding-instructions"]),
	};
}

/** Replace the coding instructions unless the style keeps them; append when the marker
 * is absent, so a custom SYSTEM.md is never clobbered. */
export function applyStyle(systemPrompt: string, style: OutputStyle): string {
	const section = `## Output Style: ${style.name}\n\n${style.body}`;
	if (!style.keepCodingInstructions) {
		const index = systemPrompt.indexOf(CODING_BASE_MARKER);
		if (index !== -1) return `${section}${systemPrompt.slice(index + CODING_BASE_MARKER.length)}`;
	}
	return `${systemPrompt}\n\n${section}`;
}

/** The user-scope Claude config directory: CLAUDE_CONFIG_DIR when set to a non-empty
 * value (a leading ~ expands against home), otherwise <home>/.claude. */
export function claudeUserDir(home: string, override?: string): string {
	if (override && override.trim().length > 0) {
		const expanded = override.startsWith("~") ? path.join(home, override.slice(1)) : override;
		return path.resolve(expanded);
	}
	return path.join(home, ".claude");
}

/** Existing style directories in ascending precedence, so a later entry wins a name
 * clash. Ancestors are walked outward first and the nearest lands last, matching
 * Claude's "the .claude/output-styles closest to the working directory wins". */
export function styleDirs(scope: StyleScope): string[] {
	const dirs = [
		scope.builtinDir,
		path.join(scope.agentDir, "output-styles"),
		path.join(claudeUserDir(scope.home, scope.claudeConfigDir), "output-styles"),
	];
	if (scope.trusted) {
		const ancestors: string[] = [];
		let current = scope.cwd;
		for (;;) {
			ancestors.push(current);
			const parent = path.dirname(current);
			if (parent === current || fs.existsSync(path.join(current, ".git"))) break;
			current = parent;
		}
		for (const dir of ancestors.reverse()) dirs.push(path.join(dir, ".claude", "output-styles"));
		dirs.push(path.join(scope.cwd, ".pi", "output-styles"));
	}
	return dirs.filter(isDirectory);
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Every style in the given directories, later directories overriding earlier ones by
 * name. An unreadable file is skipped rather than ending session start. */
export function loadStyles(dirs: string[]): OutputStyle[] {
	const byName = new Map<string, OutputStyle>();
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			let content: string;
			try {
				content = fs.readFileSync(path.join(dir, entry), "utf-8");
			} catch {
				continue;
			}
			const style = parseStyle(content, entry.replace(/\.md$/, ""));
			if (style.body.length > 0) byName.set(style.name, style);
		}
	}
	return [...byName.values()];
}

/** The styles this scope offers, in the order the picker lists them. */
export function discoverStyles(scope: StyleScope): OutputStyle[] {
	return loadStyles(styleDirs(scope));
}

/** The persisted choice, or undefined when the file is missing or unreadable. */
export function readActiveStyle(file: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (parsed !== null && typeof parsed === "object") {
			const value = (parsed as Record<string, unknown>).style;
			if (typeof value === "string" && value.length > 0) return value;
		}
	} catch {
		// missing or corrupt: no active style
	}
	return undefined;
}

/** Persist the choice through a temp file and a rename, so a crash mid-write cannot
 * truncate the state file. Returns a message when the choice could not be saved. */
export function writeActiveStyle(file: string, name: string | undefined): string | undefined {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ style: name ?? "" }, null, 2)}\n`);
		fs.renameSync(tmp, file);
	} catch {
		return "Could not save the style choice; it applies to this session only";
	}
	return undefined;
}

export default function outputStyles(pi: ExtensionAPI) {
	const builtinDir = path.join(import.meta.dirname, "..", "styles");
	const stateFile = path.join(getAgentDir(), "output-styles.json");

	let styles: OutputStyle[] = [];
	let activeName: string | undefined;

	const scopeFor = (ctx: ExtensionContext): StyleScope => ({
		cwd: ctx.cwd,
		home: os.homedir(),
		trusted: ctx.isProjectTrusted(),
		agentDir: getAgentDir(),
		builtinDir,
		claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
	});

	const active = (): OutputStyle | undefined =>
		activeName ? styles.find((style) => style.name === activeName) : undefined;

	const choose = (name: string | undefined, ctx: ExtensionContext): void => {
		activeName = name;
		const failure = writeActiveStyle(stateFile, name);
		const success = name ? `Output style set to ${name} (applies next turn)` : "Output style off";
		ctx.ui.notify(failure ?? success, failure ? "error" : "info");
	};

	/** Clear a choice that no longer resolves, without the extra "style off" notice. */
	const forget = (): void => {
		activeName = undefined;
		writeActiveStyle(stateFile, undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		const scope = scopeFor(ctx);
		styles = discoverStyles(scope);
		activeName = readActiveStyle(stateFile);
		if (activeName && !active()) {
			ctx.ui.notify(`Output style "${activeName}" not found; turned off`, "warning");
			forget();
		}
	});

	pi.on("before_agent_start", async (event) => {
		const style = active();
		if (!style) return undefined;
		return { systemPrompt: applyStyle(event.systemPrompt, style) };
	});

	pi.registerCommand("style", {
		description: "Choose the active output style (/style <name|off|reload|create>)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			if ("create".startsWith(prefix) && prefix.length > 0) return [{ value: "create", label: "create" }];
			if (["reload", "off"].some((k) => k.startsWith(prefix) && prefix.length > 0))
				return ["reload", "off"].filter((k) => k.startsWith(prefix)).map((value) => ({ value, label: value }));
			return styles
				.filter((style) => style.name.toLowerCase().startsWith(prefix))
				.map((style) => ({
					value: style.name,
					label: style.name,
					...(style.description ? { description: style.description } : {}),
				}));
		},
		handler: async (args, ctx) => {
			const requested = args.trim();

			if (requested === "reload") {
				styles = discoverStyles(scopeFor(ctx));
				ctx.ui.notify(`Reloaded ${styles.length} style(s)`, "info");
				return;
			}

			if (requested === "create") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Agent is busy; wait for the current turn to finish", "warning");
					return;
				}
				pi.sendUserMessage("Use the create-output-style skill to write an output style.");
				return;
			}

			if (requested) {
				if (["off", "none", "default"].includes(requested.toLowerCase())) {
					choose(undefined, ctx);
					return;
				}
				const picked = styles.find((style) => style.name.toLowerCase() === requested.toLowerCase());
				if (!picked) {
					const names = styles.map((style) => style.name).join(", ") || "none";
					ctx.ui.notify(`Unknown output style: ${requested}. Available: ${names}`, "error");
					return;
				}
				choose(picked.name, ctx);
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/style needs interactive mode; use /style <name> instead", "error");
				return;
			}
			if (styles.length === 0) {
				ctx.ui.notify(`No output styles found. Add markdown files to ${path.join(getAgentDir(), "output-styles")}`, "info");
				return;
			}
			// Index 0 is the off switch, so a style named "off" cannot collide with it.
			const choices = [
				"off (no style)",
				...styles.map((style) => (style.description ? `${style.name} -- ${style.description}` : style.name)),
			];
			const choice = await ctx.ui.select(`Output style (current: ${activeName ?? "none"})`, choices);
			if (!choice) return;
			const index = choices.indexOf(choice);
			choose(index === 0 ? undefined : styles[index - 1].name, ctx);
		},
	});
}
