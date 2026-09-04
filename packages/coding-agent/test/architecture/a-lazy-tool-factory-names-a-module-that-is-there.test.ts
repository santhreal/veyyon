/**
 * WHY: After a workspace move, a lazy factory can still name the old path.
 * `web_search` kept `await import("../web/search")` after search moved to
 * `tools/web/search`, so the dispatch table compiled and the tool 404'd at
 * first use. The class is every relative specifier in the tool factory
 * files: the dispatch table and every domain manifest.
 *
 * THE CHOKE POINT. Every `BuiltinToolName` and `HiddenToolName` factory is
 * declared in `tools/index.ts` or `tools/<domain>/manifest.ts`. Sweeping
 * those files, derived from the directory at run time, covers a new domain
 * the moment it arrives. A factory that uses a package specifier is an
 * edge out of the package and is not this suite's subject.
 *
 * WHAT IT DOES NOT CATCH. A specifier that resolves to the wrong module
 * (same path, different file). A factory that constructs via a helper rather
 * than `import()`.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
	importSpecifiers,
	isDirectory,
	repoPath,
	repoRelative,
	resolveSpecifier,
	subdirectories,
} from "./helpers/module-graph";

const TOOLS = repoPath("packages/coding-agent/src/tools");

/** Directories under `tools/` that are not a domain and so carry no manifest. */
const NOT_A_DOMAIN: ReadonlySet<string> = new Set(["core"]);

function domainDirectories(): string[] {
	if (!isDirectory(TOOLS)) return [];
	return subdirectories(TOOLS)
		.map(directory => basename(directory))
		.filter(name => !NOT_A_DOMAIN.has(name))
		.sort();
}

function factoryFiles(): string[] {
	const files = [join(TOOLS, "index.ts")];
	for (const name of domainDirectories()) {
		files.push(join(TOOLS, name, "manifest.ts"));
	}
	return files;
}

describe("a lazy tool factory names a module that is there", () => {
	const domains = domainDirectories();
	const files = factoryFiles();

	it("derives every domain from the tools tree, and a new one needs a recorded decision", () => {
		expect(domains).toEqual(["agent", "fs", "search", "shell", "web"]);
		for (const name of domains) {
			expect(existsSync(join(TOOLS, name, "manifest.ts")), `${name} has no manifest`).toBe(true);
		}
		expect(files).toContain(join(TOOLS, "index.ts"));
	});

	it("resolves every relative specifier in the dispatch table and every domain manifest", () => {
		const missing: { file: string; specifier: string }[] = [];
		let relativeCount = 0;
		for (const file of files) {
			for (const specifier of importSpecifiers(file)) {
				if (!specifier.startsWith(".")) continue;
				relativeCount += 1;
				if (resolveSpecifier(file, specifier) === undefined) {
					missing.push({ file: repoRelative(file), specifier });
				}
			}
		}
		expect(relativeCount).toBeGreaterThan(20);
		expect(missing).toEqual([]);
	});

	it("still finds the web_search module the leftover path would have missed", () => {
		const index = join(TOOLS, "index.ts");
		expect(resolveSpecifier(index, "./web/search")).toBe(join(TOOLS, "web/search/index.ts"));
	});

	it("fails the leftover specifier the way the incident failed", () => {
		const index = join(TOOLS, "index.ts");
		expect(resolveSpecifier(index, "../web/search")).toBeUndefined();
	});
});
