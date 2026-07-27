import * as fs from "node:fs";
import * as path from "node:path";

/**
 * How many modules a file instantiates when you import it, counted from the source.
 *
 * WHY THIS HAS ONE OWNER NOW. Three architecture gates walk the static import graph and pin a
 * ceiling on it: `packages/utils/test/barrel-stays-cheap.test.ts`, `packages/ai/test`'s cut ratchet,
 * and `packages/coding-agent/test/architecture/test-suite-module-reach.test.ts`. Each carried its own
 * copy of the walk, and the copies did not resolve the same things: one followed relative specifiers
 * only, one also followed workspace aliases and bare package names. That is not a cosmetic
 * duplication. Every one of those gates is an UPPER BOUND, so a resolver that quietly resolves less
 * reports a smaller number and the gate passes. The coding-agent suite records exactly that happening:
 * its first version read 774,730 instead of 1,020,705 because it resolved `@veyyon/utils/dirs` and not
 * `@veyyon/utils`, and a quarter of the real total went unmeasured while the suite looked healthy.
 *
 * So the walk lives here, once, and `module-reach.test.ts` tests it directly against fixtures. A gate
 * built on it inherits those tests instead of restating them, and adding a resolution rule improves
 * every gate at the same time rather than one of them.
 *
 * NOT IN THE BARREL, deliberately. `@veyyon/utils`'s own reach ceiling is the thing under measurement,
 * so re-exporting this from `index.ts` would put `node:fs` and `node:path` on the barrel's path to
 * measure the barrel. Import it as `@veyyon/utils/module-reach`.
 *
 * WHAT A CEILING HERE IS AND IS NOT. It says the graph did not widen. It does NOT predict a test run's
 * memory: Bun caches instantiated modules across test files, so a run costs the UNION of what its
 * files reach, not the sum. `test-suite-module-reach.test.ts` has the measurement.
 */

/** `import "./x"` -- a side-effect import, which instantiates the module like any other. */
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g;

/**
 * `import ... from "x"` and `export ... from "x"`, including the multi-line braced form.
 *
 * THREE THINGS THIS HAS TO GET RIGHT.
 *
 * It must cross NEWLINES, because a formatter breaks an import across lines as soon as the braces get
 * long enough. A pattern anchored on `[^;\n]` stops seeing that import the moment it happens, and
 * reports the edge is gone when only its formatting changed.
 *
 * `import type` is EXCLUDED because it is erased and costs nothing at runtime, and `await import()` is
 * excluded because deferring is one of the sanctioned ways to cut a graph: the module is not
 * instantiated until the call runs. A gate that counted either would fail a correct fix.
 *
 * AND IT MUST NOT CROSS OUT OF THE STATEMENT IT STARTED IN, which is the part that was wrong and is
 * why the middle is a character class rather than `[\s\S]*?`. Most `export`s are not re-exports:
 * `export const $env: Record<string, string> = Bun.env as ...;` starts with `export`, has no `from`,
 * and a lazy any-character middle therefore ran FORWARD through the rest of the file looking for one.
 * `packages/utils/src/env.ts` is the case that exposed it: the runaway match settled on a doc comment
 * 140 lines later that says `import { $env } from "@veyyon/utils"` as ADVICE, so `env.ts` was recorded
 * as importing its own package barrel, and every module that reached `env.ts` was credited with all 74
 * modules of it. The barrel-cost ranking was reading a sentence in a comment as an edge.
 *
 * That bug ran in both directions, which is the reason it matters more than an inflated number. A
 * `matchAll` continues after the END of a match, so every real import inside the span the runaway
 * swallowed was never examined. One non-re-export `export` could therefore hide an arbitrary number of
 * genuine edges below it, and every gate here is an upper bound, so hidden edges pass.
 *
 * The class holds exactly what an import or export CLAUSE can contain: identifiers (with `$` and `_`),
 * `*`, braces, commas, `as`, an inline `type`, and whitespace including newlines. It deliberately
 * excludes `;`, `=`, `:`, `(`, `<`, so a value declaration cannot leave its own statement.
 */
const FROM_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type[\s{*])[\w$*{},\s]*?\sfrom\s*["']([^"']+)["']/g;

/**
 * Source with comments removed, so prose ABOUT an import is not counted as one.
 *
 * Doc comments in this repo routinely show a usage example (`import { isEnoent } from "@veyyon/utils"`),
 * and the whole point of these gates is that the number reflects what the runtime instantiates. A
 * sentence cannot instantiate anything.
 *
 * Block comments go entirely. Line comments are cut only from the START of a line, never mid-line: a
 * specifier can legitimately contain `//` (`import x from "https://…"`), and cutting at the first slash
 * pair anywhere would delete real edges to prevent phantom ones. A trailing `// note` after an import
 * is harmless, because the specifier is already captured before it.
 *
 * EXPORTED because the gates need it for the same reason this module does. A structural assertion that
 * scans source for a name (`MCPManager.instance()`, a specifier, a call) finds it in the doc comment that
 * explains why the file no longer uses it, and then the gate fails on the sentence that documents the fix.
 * Two test files had their own copy of this, and one of them then asserted a specifier that only appeared
 * inside a comment. One owner, so a gate cannot read prose as code by accident.
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
	 * BARE package specifiers, mapped to the file the bare name resolves to.
	 *
	 * These matter more than the subpaths and are the easiest thing to leave out. A bare
	 * `@veyyon/utils` resolves to the whole barrel, which is the most expensive import style there is;
	 * omitting it does not fail, it silently lowers the number the gate is guarding.
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
 * Resolve one specifier, or `undefined` for anything outside the world this resolution describes.
 *
 * Bare packages are matched before aliases so `@veyyon/utils` reaches the barrel while
 * `@veyyon/utils/dirs` reaches the leaf. Getting that order wrong makes every bare import resolve to
 * nothing, which is the silent under-count this module exists to prevent.
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
 * Every module statically reachable from `entry`, including `entry` itself, as absolute paths.
 *
 * A file that cannot be READ is counted and not followed, rather than throwing. That is a narrower case
 * than it first looks, and the narrowing was measured rather than assumed: a MISSING module never
 * reaches this point at all, because `resolveFile` requires the path to exist, so it resolves to
 * `undefined` and is simply not followed. What is left is a file that existed when it was resolved and
 * could not be read a moment later: no read permission, or a regeneration that replaced it between the
 * two calls. Both happen in a repo whose builds rewrite generated modules while tests run, and neither
 * should turn an architecture ceiling into a crash. Nothing is hidden by continuing, because the edge
 * that named the file is already in the set.
 */
/**
 * A per-run memo of "which files does this file import", for a caller that walks MANY entries.
 *
 * WHY THIS EXISTS. Each walk re-reads and re-resolves every file it reaches, and the gates that use this
 * module walk one entry per test FILE: `test-suite-module-reach.test.ts` walks 1,891 of them over a graph
 * whose files are shared almost completely, so the same `readFileSync` plus regex scan plus resolution ran
 * thousands of times for one answer. Resolving the whole workspace instead of four packages made that
 * visible: the gate went from about forty seconds to minutes, which is a test nobody runs (Law 7 -- an
 * avoidable quadratic is a production bug at scale, and a gate too slow to run is a gate that stops
 * catching things).
 *
 * IT IS EXPLICIT AND PER-RUN rather than a module-level cache, because these values are read off disk and a
 * process that edits a file and re-walks must see the edit. A caller that wants one answer passes nothing
 * and pays nothing; a caller that wants a thousand creates one of these and passes it to every call.
 */
export type ModuleReachCache = Map<string, string[]>;

/** A fresh memo for one run of one gate. See {@link ModuleReachCache}. */
export function createModuleReachCache(): ModuleReachCache {
	return new Map();
}

/**
 * The files `file` imports, resolved, memoized when a cache is given.
 *
 * A file that cannot be READ has no edges rather than being dropped. That is a narrower case than it first
 * looks, and the narrowing was measured rather than assumed: a MISSING module never reaches this point at
 * all, because `resolveFile` requires the path to exist, so it resolves to `undefined` and is never named
 * here. What is left is a file that existed when it was resolved and could not be read a moment later: no
 * read permission, or a regeneration that replaced it between the two calls. Both happen in a repo whose
 * builds rewrite generated modules while tests run, and neither should turn an architecture ceiling into a
 * crash. Nothing is hidden by continuing, because the edge that named the file is already in the graph.
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
 * The same walk, kept as an adjacency list rather than a set.
 *
 * A REACH SET cannot answer "is there a cycle": that needs the edges, so a gate looking for one has to
 * keep them. `packages/coding-agent/test/architecture/no-import-cycles.test.ts` runs Tarjan over this.
 * The extraction and the resolution are the same as {@link moduleReach}, which is the point of it being
 * here: those are the two steps where a quiet omission lowers the number a gate is guarding, and a
 * cycle gate is just as blind to it as a ceiling is. A missing resolution rule means a missing edge,
 * and a missing edge means a cycle the gate reports as absent.
 *
 * A module that cannot be read gets an EMPTY edge list rather than being dropped, so it is still a node
 * in the graph. Dropping it would silently break a path through it.
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
