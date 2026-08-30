/**
 * Deriving types with ReturnType<typeof fn> couples callers to implementation details and hides return contracts.
 * This gate checks that no TypeScript source file under packages/ or scripts/ uses ReturnType in a type position.
 * It does not parse multi-line type structures across AST boundaries or enforce contracts in external fixtures.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { typeScriptRootDirectories } from "./workspace-layout.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const SKIPPED_DIRS: Record<string, true> = {
	node_modules: true,
	dist: true,
	build: true,
	vendor: true,
	"repo-cache": true,
	".cache": true,
	"devin-gen": true,
	assets: true,
};

const EXEMPTIONS: readonly string[] = [];

export function findReturnTypeSites(source: string): Array<{ line: number; text: string }> {
	const found: Array<{ line: number; text: string }> = [];
	let inBlockComment = false;

	const lines = source.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		let line = lines[index]!;
		const raw = line;

		if (inBlockComment) {
			const closeIdx = line.indexOf("*/");
			if (closeIdx === -1) {
				continue;
			}
			line = line.slice(closeIdx + 2);
			inBlockComment = false;
		}

		while (line.includes("/*")) {
			const openIdx = line.indexOf("/*");
			const closeIdx = line.indexOf("*/", openIdx + 2);
			if (closeIdx === -1) {
				line = line.slice(0, openIdx);
				inBlockComment = true;
				break;
			}
			line = line.slice(0, openIdx) + line.slice(closeIdx + 2);
		}

		const commentIdx = line.indexOf("//");
		if (commentIdx !== -1) {
			line = line.slice(0, commentIdx);
		}
		const codeOnly = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

		if (/\bReturnType\s*</.test(codeOnly)) {
			found.push({ line: index + 1, text: raw.trim() });
		}
	}

	return found;
}

function findSourceFiles(dir: string, isRoot = false): string[] {
	if (!fs.existsSync(dir)) return [];
	const results: string[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (SKIPPED_DIRS[entry.name]) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (isRoot) {
				const srcDir = path.join(full, "src");
				if (fs.existsSync(srcDir)) {
					results.push(...findSourceFiles(srcDir));
				}
			} else {
				results.push(...findSourceFiles(full));
			}
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
			results.push(path.relative(REPO_ROOT, full).replaceAll("\\", "/"));
		}
	}
	return results;
}

describe("a type is named not derived from a function", () => {
	it("finds zero ReturnType< sites in tracked TypeScript source and scripts", () => {
		// The workspace roots are read, not named. `packages/` was hardcoded, so a module under any
		// other root could derive a type from a function and this gate reported zero sites.
		const files = [
			...typeScriptRootDirectories().flatMap(root => findSourceFiles(path.join(REPO_ROOT, root), true)),
			...findSourceFiles(path.join(REPO_ROOT, "scripts")),
		].sort();

		expect(files.length).toBeGreaterThan(50);

		// And the corpus reaches every declared root. A root the walk never opened contributes no
		// file, so its modules are exempt by absence and the empty list below still reads green.
		const roots = new Set(files.map(file => file.split("/")[0]));
		expect([...roots].sort()).toEqual([...typeScriptRootDirectories(), "scripts"].sort());
		expect(files).toContain("contracts/wire/src/relay.ts");

		const violations: string[] = [];
		for (const file of files) {
			const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			const sites = findReturnTypeSites(content);
			for (const site of sites) {
				violations.push(`${file}:${site.line}: ${site.text}`);
			}
		}

		expect(violations).toEqual([...EXEMPTIONS]);
	});
});
