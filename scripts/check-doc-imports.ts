#!/usr/bin/env bun
// Import gate for documentation and examples: every named import from a
// `@veyyon/*` package that appears in a README, a doc page, or an example file
// must actually be exported by that package.
//
// Why this gate exists: `getModel`/`getModels`/`getProviders` were renamed to
// `getBundledModel`/`getBundledModels`/`getBundledProviders` and MOVED from
// `@veyyon/ai` to `@veyyon/catalog`. The CHANGELOGs recorded the rename; the
// docs did not follow. `packages/ai/README.md` went on teaching
// `import { getModel } from "@veyyon/ai"` in about thirty places, the SDK
// docblock and two runnable examples did the same, and
// `"getModel" in await import("@veyyon/ai")` is `false` — so the FIRST LINE of
// the quick start in a published package's README threw for anyone who copied
// it. Nothing failed, because no gate reads the code inside a fenced block.
//
// A name counts as exported if it is a runtime export of the package's entry
// point OR a type-only export declared in its sources (types do not exist at
// runtime, so they cannot be probed the same way). Nothing is skipped
// silently: unparsed specifiers are counted and reported.
//
// CI gate: .github/workflows/docs.yml.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { existingOnly } from "./check-doc-links";

export interface BadImport {
	file: string;
	line: number;
	specifier: string;
	name: string;
	reason: string;
}

export interface ImportCheckResult {
	filesChecked: number;
	importsChecked: number;
	/**
	 * Specifiers naming a `@veyyon/*` package with no directory under `packages/`.
	 *
	 * Reported AND counted as a finding. `packages/agent/README.md` taught
	 * `import { Agent } from "@veyyon/agent"` on its first code line while the
	 * package is named `@veyyon/agent-core`, so every snippet in it failed to
	 * resolve. A doc naming a package that does not exist is exactly as broken as
	 * one naming an export that does not exist, and letting it pass quietly is the
	 * silent-skip this gate is against.
	 */
	unknownPackages: string[];
	bad: BadImport[];
}

/**
 * `import { a, b as c } from "@veyyon/x"`, including `import type { … }` and
 * clauses spanning many lines.
 *
 * Multi-line matters more than it sounds: the biggest offender in the repository
 * was `packages/ai/README.md`'s twenty-name "Programmatic OAuth" block, and a
 * line-anchored pattern walked straight past it while flagging the one-line
 * `import { loginGitHubCopilot } from "@veyyon/ai"` twenty lines below — same
 * defect, one visible, nineteen invisible.
 */
const IMPORT_PATTERN = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["'](@veyyon\/[^"']+)["']/g;

/**
 * A clause containing any of these is not one clause: the lazy `[\s\S]*?` above
 * ran from a RELATIVE import's `{` all the way to the next `@veyyon/...`
 * specifier further down the file, swallowing every name in between —
 * `docs/internal/testing.md` reported the same nonexistent export 32 times, all
 * of them names from an unrelated block. A real named-import clause never
 * contains `import`, `from`, or `;`.
 */
const CLAUSE_BOUNDARY = /\bimport\b|\bfrom\b|;/;

/** Fenced code block delimiters, so prose that merely mentions an import is skipped. */
const FENCE = /^[ \t]*(?:```|~~~)/;

/**
 * Named-import clause -> the names as the module must export them (before `as`).
 *
 * `//` comments are stripped first, because documented clauses annotate their
 * entries (`refreshOAuthToken, // (provider, credentials) => new credentials`)
 * and the comment text would otherwise be read as further names.
 */
export function parseImportedNames(clause: string): string[] {
	const names: string[] = [];
	for (const line of clause.split("\n")) {
		const withoutComment = line.replace(/\/\/.*$/, "");
		for (const part of withoutComment.split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) names.push(name);
		}
	}
	return names;
}

/**
 * The markdown with everything outside a fenced code block blanked out, keeping
 * byte offsets and line numbers intact.
 *
 * Only fenced blocks are scanned. Prose says things like "the old
 * `import { getModel } from "@veyyon/ai"` form", and flagging that would make
 * the gate unable to describe its own history. Blanking rather than filtering is
 * what lets a multi-line clause still be matched across the lines it spans.
 */
export function fencedOnly(markdown: string): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map(text => {
			if (FENCE.test(text)) {
				inFence = !inFence;
				return "";
			}
			return inFence ? text : "";
		})
		.join("\n");
}

/** 1-indexed line number of `offset` within `text`. */
export function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") line += 1;
	}
	return line;
}

/** Package directory under `packages/` whose `package.json` declares `name`. */
function packageDirs(repoRoot: string): Map<string, string> {
	const map = new Map<string, string>();
	const packagesDir = path.join(repoRoot, "packages");
	for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifest = path.join(packagesDir, entry.name, "package.json");
		if (!fs.existsSync(manifest)) continue;
		const name: unknown = JSON.parse(fs.readFileSync(manifest, "utf8")).name;
		if (typeof name === "string") map.set(name, path.join(packagesDir, entry.name));
	}
	return map;
}

/**
 * Every `export`ed type/interface/class name in a package's sources, following
 * `export * from "@veyyon/<other>"` into the packages it re-exports.
 *
 * Following the hop is required, not thorough: `packages/ai/src/types.ts` is
 * `export * from "@veyyon/catalog/types"`, so `import type { Model } from
 * "@veyyon/ai"` is CORRECT even though nothing in `packages/ai` declares
 * `Model`. Without the hop the gate reported two such imports as broken, which is
 * the failure mode that makes a gate get switched off.
 */
function typeExportsOf(packageDir: string, dirs: Map<string, string>, seen = new Set<string>()): Set<string> {
	if (seen.has(packageDir)) return new Set();
	seen.add(packageDir);
	const names = new Set<string>();
	const stack = [path.join(packageDir, "src")];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).values()) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") stack.push(full);
				continue;
			}
			if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
			const text = fs.readFileSync(full, "utf8");
			for (const match of text.matchAll(
				/export\s+(?:declare\s+)?(?:type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/g,
			)) {
				names.add(match[1]);
			}
			// `export type { A, B } from "./x"` / `export type { A }`
			for (const match of text.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
				for (const name of parseImportedNames(match[1])) names.add(name);
			}
			// `export * from "@veyyon/other"` / `export type * from "@veyyon/other/sub"`
			for (const match of text.matchAll(/export\s+(?:type\s+)?\*\s+from\s*["'](@veyyon\/[^"']+)["']/g)) {
				const parts = match[1].split("/");
				const target = dirs.get(`${parts[0]}/${parts[1]}`);
				if (!target) continue;
				for (const name of typeExportsOf(target, dirs, seen)) names.add(name);
			}
		}
	}
	return names;
}

/** Runtime exports of a package entry point, or null when it cannot be loaded. */
async function runtimeExportsOf(packageName: string, subpath: string | undefined): Promise<Set<string> | null> {
	const specifier = subpath ? `${packageName}/${subpath}` : packageName;
	try {
		return new Set(Object.keys((await import(specifier)) as Record<string, unknown>));
	} catch {
		return null;
	}
}

/** Files this gate reads: tracked markdown plus tracked example sources. */
export function documentationFiles(repoRoot: string): string[] {
	const listed = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8" });
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	// `existingOnly`: the index still lists a file deleted in the working tree,
	// and reading it would kill this gate with an ENOENT that says nothing about
	// imports. See its doc in check-doc-links.ts.
	return existingOnly(
		repoRoot,
		listed.stdout
			.split("\0")
			.filter(Boolean)
			.filter(rel => {
				if (rel.includes("node_modules/") || rel.includes("repo-cache/")) return false;
				if (rel.endsWith("CHANGELOG.md")) return false; // history, deliberately naming old APIs
				if (rel.endsWith(".md")) return true;
				return /(^|\/)examples\//.test(rel) && /\.(ts|tsx|js|mjs)$/.test(rel);
			}),
	);
}

export async function checkDocImports(repoRoot: string, files?: readonly string[]): Promise<ImportCheckResult> {
	const dirs = packageDirs(repoRoot);
	const typeCache = new Map<string, Set<string>>();
	const runtimeCache = new Map<string, Set<string> | null>();
	const result: ImportCheckResult = { filesChecked: 0, importsChecked: 0, unknownPackages: [], bad: [] };

	for (const rel of files ?? documentationFiles(repoRoot)) {
		const abs = path.join(repoRoot, rel);
		if (!fs.existsSync(abs)) continue;
		const raw = fs.readFileSync(abs, "utf8");
		const text = rel.endsWith(".md") ? fencedOnly(raw) : raw;
		result.filesChecked += 1;

		for (const match of text.matchAll(IMPORT_PATTERN)) {
			if (CLAUSE_BOUNDARY.test(match[1])) continue;
			const line = lineAt(text, match.index ?? 0);
			const specifier = match[2];
			// `@veyyon/pkg` or `@veyyon/pkg/subpath`
			const parts = specifier.split("/");
			const packageName = `${parts[0]}/${parts[1]}`;
			const subpath = parts.slice(2).join("/") || undefined;
			const packageDir = dirs.get(packageName);
			if (!packageDir) {
				if (!result.unknownPackages.includes(specifier)) result.unknownPackages.push(specifier);
				result.bad.push({
					file: rel,
					line,
					specifier,
					name: "*",
					reason: `no package under packages/ is named \`${packageName}\` (check the package.json "name")`,
				});
				continue;
			}

			const cacheKey = specifier;
			if (!runtimeCache.has(cacheKey)) {
				runtimeCache.set(cacheKey, await runtimeExportsOf(packageName, subpath));
			}
			const runtime = runtimeCache.get(cacheKey) ?? null;
			if (!typeCache.has(packageName)) typeCache.set(packageName, typeExportsOf(packageDir, dirs));
			const types = typeCache.get(packageName) as Set<string>;

			for (const name of parseImportedNames(match[1])) {
				result.importsChecked += 1;
				if (runtime === null) {
					result.bad.push({
						file: rel,
						line,
						specifier,
						name,
						reason: `cannot load ${specifier} to verify its exports`,
					});
					continue;
				}
				if (runtime.has(name) || types.has(name)) continue;
				result.bad.push({
					file: rel,
					line,
					specifier,
					name,
					reason: `${specifier} exports no \`${name}\` (neither a runtime export nor a declared type)`,
				});
			}
		}
	}
	return result;
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const result = await checkDocImports(repoRoot);
	console.log(
		`checked ${result.importsChecked} documented imports across ${result.filesChecked} files` +
			(result.unknownPackages.length > 0 ? ` (${result.unknownPackages.length} unknown specifiers)` : ""),
	);
	for (const specifier of result.unknownPackages) {
		console.error(`  unknown package specifier (not under packages/): ${specifier}`);
	}
	for (const bad of result.bad) {
		console.error(`${bad.file}:${bad.line}: ${bad.reason}`);
	}
	if (result.bad.length > 0) {
		console.error(`\n${result.bad.length} documented import(s) name something that does not exist.`);
		process.exit(1);
	}
}
