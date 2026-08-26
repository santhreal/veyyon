import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Static import graph reach analyzer to measure module instantiation counts.
 * Used by architecture gates to enforce import budget ceilings.
 */

/** `import "./x"` -- a side-effect import, which instantiates the module like any other. */
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g;

/**
 * Matches `import ... from "x"` and `export ... from "x"` across multiple lines,
 * excluding type-only imports and statements without `from`.
 */
const FROM_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type[\s{*])[\w$*{},\s]*?\sfrom\s*["']([^"']+)["']/g;

/**
 * Returns source text with block and leading line comments stripped so doc examples
 * are not counted as active imports.
 */
export function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(line => (line.trimStart().startsWith("//") ? "" : line))
		.join("\n");
}

/** How to resolve non-relative specifiers, so a gate can decide what counts as inside its world. */
export interface ModuleReachResolution {
	/**
	 * Subpath prefixes, longest match wins. `["@veyyon/utils/", "/abs/packages/utils/src/"]` makes
	 * `@veyyon/utils/dirs` resolve to that package's source rather than to a built entry point, because
	 * a test importing it instantiates the source graph in the same realm and pays exactly what a
	 * relative import of the same files pays.
	 */
	readonly aliases?: ReadonlyArray<readonly [string, string]>;
	/**
	 * Bare package specifiers mapped to their resolved entry point files.
	 */
	readonly packages?: ReadonlyArray<readonly [string, string]>;
}

/** Every module specifier `source` instantiates at runtime, in source order. */
export function moduleSpecifiersIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(SIDE_EFFECT_IMPORT_RE)) if (match[1]) found.push(match[1]);
	for (const match of code.matchAll(FROM_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

/**
 * Matches `import type ... from "x"` and `export type ... from "x"` for type-only imports.
 */
const TYPE_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+type[\s{*][\w$*{},\s]*?\sfrom\s*["']([^"']+)["']/g;

/** Every module specifier `source` names for TYPES ONLY, in source order. See {@link TYPE_IMPORT_RE}. */
export function typeOnlyModuleSpecifiersIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(TYPE_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

/**
 * Matches dynamic import specifiers in source text.
 */
// Anchored on the opening `import(` and the literal only. Requiring the closing paren made the
// reader brittle in exactly the way it exists to fix: a formatter breaking the call across lines
// leaves a trailing comma, and import attributes (`import("x", { with: ... })`) put a whole object
// between the specifier and the `)`. A string literal in the first argument position is already
// unambiguous.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;

/** Every module specifier `source` imports DYNAMICALLY, in source order. See {@link DYNAMIC_IMPORT_RE}. */
export function dynamicImportSpecifiersIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

/**
 * Extracts destructured binding names from dynamic imports for a given specifier.
 */
export function dynamicImportBindings(source: string, specifier: string): string[] {
	const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`\\{([^}]*)\\}\\s*=\\s*await\\s+import\\s*\\(\\s*["']${quoted}["']`, "g");
	const found: string[] = [];
	for (const match of withoutComments(source).matchAll(re)) {
		for (const entry of (match[1] ?? "").split(",")) {
			// `a: b` binds `b` in a destructuring, the way `a as b` does in an import clause.
			const parts = entry.trim().split(":");
			const bound = (parts.length > 1 ? parts[1] : parts[0])?.trim();
			if (bound) found.push(bound);
		}
	}
	return found;
}

/**
 * The clause of every `import`/`export ... from "<specifier>"` statement, for one exact specifier.
 *
 * Both the value and the type forms are matched, because the question this answers is "where does
 * this name come from", and that is settled the same way either way.
 */
function importClausesFrom(code: string, specifier: string): string[] {
	const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(?:^|\\n)[ \\t]*(?:import|export)\\s+([\\w$*{},\\s]*?)\\sfrom\\s*["']${quoted}["']`, "g");
	return [...code.matchAll(re)].map(match => match[1] ?? "");
}

/**
 * Returns all imported or exported binding names from `specifier`, mapping aliases to their local names.
 */
export function namedImportsFrom(source: string, specifier: string): string[] {
	const found: string[] = [];
	for (const clause of importClausesFrom(withoutComments(source), specifier)) {
		const braces = clause.match(/\{([\s\S]*)\}/);
		if (!braces?.[1]) continue;
		for (const entry of braces[1].split(",")) {
			const name = entry.trim().replace(/^type\s+/, "");
			if (!name) continue;
			// `a as b` binds `b`, which is the name the module actually uses.
			const parts = name.split(/\s+as\s+/);
			const bound = (parts.length > 1 ? parts[1] : parts[0])?.trim();
			if (bound) found.push(bound);
		}
	}
	return found;
}

/** The file a base path resolves to, trying the extensions the runtime tries, in the same order. */
function resolveFile(base: string): string | undefined {
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
	]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * Resolves a module specifier to an absolute file path using the provided resolution rules.
 */
export function resolveModuleSpecifier(
	fromFile: string,
	specifier: string,
	resolution: ModuleReachResolution = {},
): string | undefined {
	if (specifier.startsWith(".")) return resolveFile(path.resolve(path.dirname(fromFile), specifier));
	for (const [name, entry] of resolution.packages ?? []) {
		if (specifier === name) return resolveFile(entry);
	}
	let bestPrefix = "";
	let bestDir: string | undefined;
	for (const [prefix, dir] of resolution.aliases ?? []) {
		if (specifier.startsWith(prefix) && prefix.length > bestPrefix.length) {
			bestPrefix = prefix;
			bestDir = dir;
		}
	}
	if (bestDir !== undefined) return resolveFile(path.join(bestDir, specifier.slice(bestPrefix.length)));
	return undefined;
}

/**
 * Per-run cache mapping file paths to their resolved imported files.
 */
export type ModuleReachCache = Map<string, string[]>;

/** A fresh memo for one run of one gate. See {@link ModuleReachCache}. */
export function createModuleReachCache(): ModuleReachCache {
	return new Map();
}

/**
 * Resolves and returns all file paths imported by `file`, using cache if provided.
 */
function edgesOf(file: string, resolution: ModuleReachResolution, cache?: ModuleReachCache): string[] {
	const memo = cache?.get(file);
	if (memo !== undefined) return memo;

	let source: string;
	try {
		source = fs.readFileSync(file, "utf-8");
	} catch {
		cache?.set(file, []);
		return [];
	}
	const out: string[] = [];
	for (const specifier of moduleSpecifiersIn(source)) {
		const resolved = resolveModuleSpecifier(file, specifier, resolution);
		if (resolved !== undefined) out.push(resolved);
	}
	cache?.set(file, out);
	return out;
}

/**
 * Every module statically reachable from `entry`, including `entry` itself, as absolute paths.
 *
 * Pass a {@link ModuleReachCache} when walking many entries over one graph; see {@link edgesOf} for what a
 * file that cannot be read contributes.
 */
export function moduleReach(
	entry: string,
	resolution: ModuleReachResolution = {},
	cache?: ModuleReachCache,
): Set<string> {
	const seen = new Set<string>();
	const stack = [path.resolve(entry)];
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const next of edgesOf(file, resolution, cache)) if (!seen.has(next)) stack.push(next);
	}
	return seen;
}

/** How many modules `entry` instantiates, itself included. */
export function moduleReachCount(
	entry: string,
	resolution: ModuleReachResolution = {},
	cache?: ModuleReachCache,
): number {
	return moduleReach(entry, resolution, cache).size;
}

/**
 * Walks the import graph from `entry` and returns an adjacency list map of dependencies.
 */
export function moduleGraph(
	entry: string,
	resolution: ModuleReachResolution = {},
	cache?: ModuleReachCache,
): Map<string, string[]> {
	const edges = new Map<string, string[]>();
	const stack = [path.resolve(entry)];
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (edges.has(file)) continue;
		const out = edgesOf(file, resolution, cache);
		edges.set(file, out);
		for (const next of out) if (!edges.has(next)) stack.push(next);
	}
	return edges;
}
