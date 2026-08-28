/**
 * Dependency-edge extraction for the boundary suites.
 *
 * A boundary rule is a statement about the module graph, and a module's own
 * import declarations are the only place that graph exists. So these helpers
 * read specifiers — not prose, not comments, not identifiers, and never the
 * shape of an implementation. An assertion built on them survives a rename, a
 * comment reflow and a refactor, and fails exactly when an edge appears.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Repository root, derived from this file's own location. */
export const REPO_ROOT = new URL("../../../../..", import.meta.url).pathname.replace(/\/$/, "");

/** Absolute path of a repo-relative path. */
export function repoPath(...parts: string[]): string {
	return join(REPO_ROOT, ...parts);
}

/** Every `.ts` file under `root`, recursively, excluding declaration files. */
export function typeScriptFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
			found.push(path);
		}
	};
	walk(root);
	return found;
}

/** Directories directly under `root`. */
export function subdirectories(root: string): string[] {
	return readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => join(root, entry.name));
}

/** Whether `path` is a directory that exists. */
export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Module specifiers a file declares.
 *
 * Covers the four forms that create an edge: `import … from "x"`, a bare
 * `import "x"`, `export … from "x"`, and `require("x")`. Dynamic `import("x")`
 * is included because it is an edge even though the repo bans it, so a boundary
 * cannot be crossed by hiding the import inside a function.
 */
export function importSpecifiers(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const specifiers: string[] = [];
	const patterns = [
		/(?:^|\n)\s*import\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
		/(?:^|\n)\s*import\s*["']([^"']+)["']/g,
		/(?:^|\n)\s*export\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
	}
	return specifiers;
}

/** One offending edge, named so a failure states the file and the specifier. */
export interface Edge {
	file: string;
	specifier: string;
}

/** Every edge from a file under `root` whose specifier `forbidden` accepts. */
export function forbiddenEdges(root: string, forbidden: (specifier: string) => boolean): Edge[] {
	const edges: Edge[] = [];
	for (const file of typeScriptFiles(root)) {
		for (const specifier of importSpecifiers(file)) {
			if (forbidden(specifier)) edges.push({ file: relative(REPO_ROOT, file), specifier });
		}
	}
	return edges;
}

/** Line count of a file, so a size gate reports a number and not a verdict. */
export function lineCount(file: string): number {
	const source = readFileSync(file, "utf8");
	if (source === "") return 0;
	const lines = source.split("\n");
	// A trailing newline produces a final empty element that is not a line.
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** Path relative to the repo root, with forward slashes on every platform. */
export function repoRelative(file: string): string {
	return relative(REPO_ROOT, file).split(sep).join("/");
}
