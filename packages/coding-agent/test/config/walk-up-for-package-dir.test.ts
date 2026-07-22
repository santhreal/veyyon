import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { walkUpForPackageDir } from "@veyyon/coding-agent/config";
import { removeWithRetries } from "@veyyon/utils";

/**
 * walkUpForPackageDir climbs from a start directory toward the filesystem root and returns the FIRST
 * ancestor (inclusive of the start dir) that contains a package.json, or undefined if none does. It is
 * how getPackageDir locates the installed package root (for the changelog path, bundled assets, etc.)
 * and it had no direct test. The contracts pinned here are the ones a packaging regression would break:
 *   - the start directory itself counts when it holds a package.json;
 *   - a nested start finds the NEAREST ancestor package.json, not a farther one (so a nested workspace
 *     package resolves to itself, never to the monorepo root above it);
 *   - a tree with no package.json up to the root returns undefined rather than looping or throwing.
 * The loop terminates at the root via `dir !== path.dirname(dir)`, so the undefined case must actually
 * reach the top without hanging.
 */
describe("walkUpForPackageDir", () => {
	const tempDirs: string[] = [];
	const makeTree = (prefix: string): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) await removeWithRetries(dir);
	});

	it("returns the start directory itself when it holds a package.json", () => {
		const root = makeTree("wup-self-");
		fs.writeFileSync(path.join(root, "package.json"), "{}");
		expect(walkUpForPackageDir(root)).toBe(root);
	});

	it("finds a package.json in an ancestor of a nested start directory", () => {
		const root = makeTree("wup-anc-");
		const pkgDir = path.join(root, "a", "b");
		const deep = path.join(pkgDir, "c", "d");
		fs.mkdirSync(deep, { recursive: true });
		fs.writeFileSync(path.join(pkgDir, "package.json"), "{}");
		expect(walkUpForPackageDir(deep)).toBe(pkgDir);
	});

	it("returns the NEAREST ancestor when two ancestors both have a package.json", () => {
		const root = makeTree("wup-nearest-");
		const outer = path.join(root, "outer");
		const inner = path.join(outer, "inner");
		const start = path.join(inner, "start");
		fs.mkdirSync(start, { recursive: true });
		fs.writeFileSync(path.join(outer, "package.json"), "{}");
		fs.writeFileSync(path.join(inner, "package.json"), "{}");
		expect(walkUpForPackageDir(start)).toBe(inner);
	});

	it("returns undefined when no ancestor up to the root has a package.json", () => {
		const root = makeTree("wup-none-");
		const start = path.join(root, "x", "y");
		fs.mkdirSync(start, { recursive: true });
		// A fresh system temp dir has no package.json anywhere from here up to the root.
		expect(walkUpForPackageDir(start)).toBeUndefined();
	});
});
