import * as fs from "node:fs";
import * as path from "node:path";

const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g;

const FROM_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type[\s{*])[\w$*{},\s]*?\sfrom\s*["']([^"']+)["']/g;

export function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(line => (line.trimStart().startsWith("//") ? "" : line))
		.join("\n");
}

export interface ModuleReachResolution {
	readonly aliases?: ReadonlyArray<readonly [string, string]>;
	readonly packages?: ReadonlyArray<readonly [string, string]>;
}

export function moduleSpecifiersIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(SIDE_EFFECT_IMPORT_RE)) if (match[1]) found.push(match[1]);
	for (const match of code.matchAll(FROM_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

const TYPE_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+type[\s{*][\w$*{},\s]*?\sfrom\s*["']([^"']+)["']/g;

export function typeOnlyModuleSpecifiersIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(TYPE_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;

export function dynamicImportSpecifiersIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

export function dynamicImportBindings(source: string, specifier: string): string[] {
	const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`\\{([^}]*)\\}\\s*=\\s*await\\s+import\\s*\\(\\s*["']${quoted}["']`, "g");
	const found: string[] = [];
	for (const match of withoutComments(source).matchAll(re)) {
		for (const entry of (match[1] ?? "").split(",")) {
			const parts = entry.trim().split(":");
			const bound = (parts.length > 1 ? parts[1] : parts[0])?.trim();
			if (bound) found.push(bound);
		}
	}
	return found;
}

function importClausesFrom(code: string, specifier: string): string[] {
	const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(?:^|\\n)[ \\t]*(?:import|export)\\s+([\\w$*{},\\s]*?)\\sfrom\\s*["']${quoted}["']`, "g");
	return Array.from(code.matchAll(re)).map(match => match[1] ?? "");
}

export function namedImportsFrom(source: string, specifier: string): string[] {
	const found: string[] = [];
	for (const clause of importClausesFrom(withoutComments(source), specifier)) {
		const braces = clause.match(/\{([\s\S]*)\}/);
		if (!braces?.[1]) continue;
		for (const entry of braces[1].split(",")) {
			const name = entry.trim().replace(/^type\s+/, "");
			if (!name) continue;
			const parts = name.split(/\s+as\s+/);
			const bound = (parts.length > 1 ? parts[1] : parts[0])?.trim();
			if (bound) found.push(bound);
		}
	}
	return found;
}

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

export type ModuleReachCache = Map<string, string[]>;

export function createModuleReachCache(): ModuleReachCache {
	return new Map();
}

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

export function moduleReachCount(
	entry: string,
	resolution: ModuleReachResolution = {},
	cache?: ModuleReachCache,
): number {
	return moduleReach(entry, resolution, cache).size;
}

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
