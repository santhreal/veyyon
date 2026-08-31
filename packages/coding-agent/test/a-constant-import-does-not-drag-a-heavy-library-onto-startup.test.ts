import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * WHY: importing a string constant is enough to evaluate the module that holds it, and twice now a
 * module that wanted one literal has put a multi-megabyte library on the session startup path.
 *
 * `tools/fs/read.ts`, `tools/web/fetch.ts` and `cli/file-processor.ts` imported `CONVERTIBLE_EXTENSIONS`, a
 * nine-string set, from the `markit` barrel. The barrel reaches `markit/registry.ts`, which statically
 * imports five document converters and through them mammoth, jszip, turndown, domino, bluebird and
 * xmlbuilder: 104ms of module evaluation to read nine strings, while `utils/markit.ts` was already
 * loading the converters through a dynamic import because the laziness was intended. Separately,
 * `web/scrapers/types.ts` imported `CHROME_WINDOWS_USER_AGENT` from `browser-headers.ts`, which
 * statically imports `header-generator` and pays 19ms to read its Bayesian traffic model.
 *
 * The class is "a static import edge that exists only to reach a constant, ending at an expensive
 * third-party package". This suite closes it structurally rather than by timing: it walks the real
 * static-import graph from the real startup roots and fails when any of them can reach a package on
 * the budget list.
 *
 * The roots are derived from source at run time. Every entry in the tool factory table in
 * `tools/index.ts` is a dynamic import that `createTools` immediately awaits during
 * `createAgentSession`, so a factory's module and everything statically reachable from it is startup
 * cost despite the `await import()` spelling. Adding a tool adds a root here with no edit.
 *
 * What this does NOT catch: a heavy package reached through a genuinely deferred dynamic import
 * inside a tool module (correct, that is the fix these defects wanted), a package that is expensive
 * but absent from EXPENSIVE_PACKAGES, and runtime cost that is not module evaluation.
 */

const SRC = resolve(import.meta.dirname, "..", "src");

/**
 * Third-party packages whose module evaluation is expensive enough that reaching one from a startup
 * root is a defect rather than a cost. Measured by importing each in isolation on a quiet machine.
 *
 * Pinned by exact equality below so that adding or removing a package is a recorded decision.
 */
const EXPENSIVE_PACKAGES = [
	"@mixmark-io/domino",
	"bluebird",
	"header-generator",
	"jszip",
	"mammoth",
	"turndown",
	"xmlbuilder",
] as const;

/**
 * Resolve a relative specifier the way the runtime does, including directory index files.
 *
 * The candidate must be a FILE. `../markit` names a directory that exists, and accepting it dead-ends
 * the walk one edge short of the barrel that holds the expensive imports, which is the exact edge this
 * suite is here to see.
 */
function resolveRelative(specifier: string, fromFile: string): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
		join(base, "index.js"),
	];
	return candidates.find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
}

interface ModuleImports {
	/** Bare specifiers (`mammoth`, `@veyyon/utils/format`) this file imports statically. */
	bare: string[];
	/** Absolute paths of first-party files this file imports statically. */
	local: string[];
}

/**
 * The `tsx` loader reads `<T>` in a type position as JSX, which makes it reject ordinary `.ts` files
 * such as `task/executor.ts`. Pick the loader from the extension.
 */
const transpilers: Record<string, Bun.Transpiler> = {
	".ts": new Bun.Transpiler({ loader: "ts" }),
	".tsx": new Bun.Transpiler({ loader: "tsx" }),
	".js": new Bun.Transpiler({ loader: "js" }),
};
const importCache = new Map<string, ModuleImports>();

/**
 * Files the walker could not parse. A parse failure silently prunes a subtree, which is the same
 * blindness as resolving nothing, so the sweep asserts this stays empty rather than skipping them.
 */
const unscannable = new Set<string>();

/**
 * Static imports only. `scanImports` reports a dynamic `import()` with kind `dynamic-import`, which is
 * exactly the deferral these fixes introduced, so following one would defeat the test. It reports
 * `export * from` and `export { x } from` as `import-statement`, which is correct: a re-export
 * evaluates the module it names, and that is how the markit barrel carried the converters.
 */
function staticImportsOf(file: string): ModuleImports {
	const cached = importCache.get(file);
	if (cached) return cached;

	const bare: string[] = [];
	const local: string[] = [];
	const extension = file.slice(file.lastIndexOf("."));
	const transpiler = transpilers[extension];
	if (transpiler) {
		let records: ReadonlyArray<{ kind: string; path: string }> = [];
		try {
			records = transpiler.scanImports(readFileSync(file, "utf8"));
		} catch {
			unscannable.add(relative(SRC, file));
		}
		for (const record of records) {
			if (record.kind !== "import-statement") continue;
			const specifier = record.path;
			if (specifier.startsWith(".")) {
				const resolved = resolveRelative(specifier, file);
				if (resolved) local.push(resolved);
				continue;
			}
			if (!specifier.startsWith("node:") && !specifier.startsWith("bun:")) bare.push(specifier);
		}
	}

	const imports: ModuleImports = { bare, local };
	importCache.set(file, imports);
	return imports;
}

/** The eagerly awaited tool-factory modules, read out of the factory table itself. */
function startupRoots(): Map<string, string> {
	const roots = new Map<string, string>();
	for (const table of factoryTableFiles()) {
		const source = readFileSync(table, "utf8");
		// Each factory is `<name>: async s => ... await import("<specifier>") ...` on one or more lines.
		for (const match of source.matchAll(/await import\((["'])([^"']+)\1\)/g)) {
			const specifier = match[2];
			if (!specifier?.startsWith(".")) continue;
			const resolved = resolveRelative(specifier, table);
			if (resolved) roots.set(resolved, specifier);
		}
	}
	return roots;
}

/**
 * Every file that holds tool factories: `tools/index.ts` and each domain's `manifest.ts`.
 *
 * The domain directory is read at run time rather than listed, so a domain added tomorrow is measured
 * without an edit here. A hardcoded list would lower this ceiling in silence, which is the failure
 * mode the whole suite is built to avoid.
 */
function factoryTableFiles(): string[] {
	const toolsDir = join(SRC, "tools");
	const files = [join(toolsDir, "index.ts")];
	for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifest = join(toolsDir, entry.name, "manifest.ts");
		if (existsSync(manifest)) files.push(manifest);
	}
	return files;
}

/** Every expensive package reachable from `root` through static imports, with the path that reaches it. */
function expensiveReachableFrom(root: string): Map<string, string[]> {
	const found = new Map<string, string[]>();
	const seen = new Set<string>();
	const queue: Array<{ file: string; trail: string[] }> = [{ file: root, trail: [root] }];

	while (queue.length > 0) {
		const next = queue.pop();
		if (!next) break;
		if (seen.has(next.file)) continue;
		seen.add(next.file);

		const { bare, local } = staticImportsOf(next.file);
		for (const specifier of bare) {
			const hit = EXPENSIVE_PACKAGES.find(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`));
			if (hit && !found.has(hit)) {
				found.set(hit, next.trail.map(file => relative(SRC, file)).concat(specifier));
			}
		}
		for (const dependency of local) queue.push({ file: dependency, trail: [...next.trail, dependency] });
	}

	return found;
}

describe("a startup root cannot reach an expensive third-party package through static imports", () => {
	it("pins the package budget so adding one is a decision", () => {
		expect([...EXPENSIVE_PACKAGES]).toEqual([
			"@mixmark-io/domino",
			"bluebird",
			"header-generator",
			"jszip",
			"mammoth",
			"turndown",
			"xmlbuilder",
		]);
	});

	it("derives its roots from the tool factory table rather than a hardcoded list", () => {
		const roots = startupRoots();
		// A regression that empties this set would make every other assertion vacuously true.
		expect(roots.size).toBeGreaterThan(20);
		expect([...roots.values()]).toContain("../web/search");
		expect([...roots.values()]).toContain("./read");
	});

	it("reaches no expensive package from any eagerly awaited tool factory", () => {
		const offenders: string[] = [];
		for (const [root, specifier] of startupRoots()) {
			for (const [pkg, trail] of expensiveReachableFrom(root)) {
				offenders.push(`${specifier} -> ${pkg}\n    via ${trail.join("\n     -> ")}`);
			}
		}
		expect(offenders).toEqual([]);
		// A file the parser rejected contributes no edges, so its whole subtree would pass unexamined.
		expect([...unscannable]).toEqual([]);
	});

	it("reaches no expensive package from the non-tool startup modules that triggered this suite", () => {
		const offenders: string[] = [];
		for (const entry of ["cli/file-processor.ts", "web/scrapers/types.ts", "web/search/providers/perplexity.ts"]) {
			const root = join(SRC, entry);
			expect(existsSync(root)).toBe(true);
			for (const [pkg, trail] of expensiveReachableFrom(root)) {
				offenders.push(`${entry} -> ${pkg}\n    via ${trail.join("\n     -> ")}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps the two constant leaves import-free, which is the property that makes them cheap", () => {
		for (const leaf of [
			"markit/convertible-extensions.ts",
			"web/search/providers/browser-fingerprint-constants.ts",
		]) {
			const { bare, local } = staticImportsOf(join(SRC, leaf));
			expect({ leaf, bare, local }).toEqual({ leaf, bare: [], local: [] });
		}
	});

	it("still sees the expensive packages where they legitimately live, so the walker is not blind", () => {
		// A walker that resolved nothing would report zero offenders everywhere.
		// `export/markit/registry.ts` genuinely imports the converters, and
		// `browser-headers.ts` genuinely imports header-generator.
		expect([...expensiveReachableFrom(join(SRC, "export", "markit", "registry.ts")).keys()].sort()).toContain(
			"mammoth",
		);
		expect([...expensiveReachableFrom(join(SRC, "web", "search", "providers", "browser-headers.ts")).keys()]).toEqual(
			["header-generator"],
		);
	});

	it("follows a re-export edge, which is the shape that carried the converters", () => {
		// `export/markit/index.ts` names the converters only through
		// `export * from "./registry"`. A walker that followed `import` but not
		// `export * from` would call the barrel clean and miss the whole defect.
		const barrel = readFileSync(join(SRC, "export", "markit", "index.ts"), "utf8");
		expect(barrel).toContain('export * from "./registry"');
		expect(barrel).not.toContain("import ");
		expect([...expensiveReachableFrom(join(SRC, "export", "markit", "index.ts")).keys()].sort()).toContain("mammoth");
	});
});
