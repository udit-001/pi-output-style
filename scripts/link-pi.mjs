/**
 * Junction the installed pi package into ./node_modules so the tests can import
 * "@earendil-works/pi-coding-agent" the way the extension does at runtime.
 *
 * A local pi package is loaded in place, so it has no node_modules of its own: pi
 * provides the real module at runtime. The tests need the same module resolvable
 * locally, and a Windows junction needs no elevation.
 *
 * Usage: node scripts/link-pi.mjs [packageRoot]
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));

/** The real package: a local install if one exists, otherwise the global install pi
 * itself runs from. Resolving through npm keeps a hardcoded path out of the script. */
function findPiPackage() {
	try {
		return dirname(createRequire(join(root, "package.json")).resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		// no local install; fall through to the global one
	}
	const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
	const candidate = join(globalRoot, "@earendil-works", "pi-coding-agent");
	if (!existsSync(join(candidate, "package.json"))) {
		throw new Error(`pi not found at ${candidate}; install pi first, or npm install --save-dev @earendil-works/pi-coding-agent`);
	}
	return candidate;
}

const target = findPiPackage();
const link = join(root, "node_modules", "@earendil-works", "pi-coding-agent");

mkdirSync(dirname(link), { recursive: true });
try {
	// force-remove first: existsSync follows the link, so a broken one reports missing.
	rmSync(link, { recursive: true, force: true });
} catch {
	// nothing to remove
}
symlinkSync(target, link, "junction");
console.log(`linked ${link} -> ${target}`);
