/**
 * The package's hot import graphs stay acyclic.
 *
 * WHY THIS SUITE EXISTS. Import cycles in this package are not a style problem,
 * they are the reason a full test run was OOM-killed. A cycle is one strongly
 * connected component and has to be instantiated as a unit, so importing ANY
 * member costs what the whole component costs, and Bun's test runner gives every
 * test file a fresh realm. Two cycles did the damage:
 *
 *   config/settings -> modes/theme/theme -> modes/theme/shimmer -> config/settings
 *
 *   tools/path-utils -> internal-urls -> internal-urls/skill-protocol ->
 *   extensibility/skills -> discovery -> discovery/builtin -> tools/path-utils
 *
 * The second pulled two dozen modules into one component, including `mcp/*`,
 * `lsp/utils` and `config.ts`. Measured with twenty identical test files that did
 * nothing but import one module, every member of it reported the same figure:
 * `path-utils` 51.7 MB per file, `internal-urls` 51.7, `discovery` 51.5,
 * `config/settings` 51.4. Modules just outside cost a fraction of that:
 * `settings-schema` 15.4, `capability/fs` 7.1, `extensibility/manifest-key` 1.9.
 * Since `path-utils` is imported for small helpers throughout the package, that
 * cost reached nearly everything.
 *
 * Cutting the two edges moved those same numbers: `path-utils` 51.7 to 7.8 MB per
 * file, `config/settings` 51.4 to 15.6, `modes/theme/theme` 51.2 to 16.1,
 * `discovery` 51.5 to 44.0. `path-utils` now reaches two modules in total, and the
 * graphs under `discovery`, `config/settings` and `theme` are acyclic.
 *
 * WHAT THIS ASSERTS AND WHY IT IS STRUCTURAL. Each cycle was closed by ONE import
 * line, and each is a one-line change to reintroduce, with no failing behaviour to
 * catch it: everything still works, it just costs 51 MB per realm again. So this
 * checks the graph itself. It resolves the real static import edges from source
 * and runs Tarjan over them, rather than pattern-matching on known-bad pairs,
 * which would miss a new cycle through a different route.
 *
 * `import type` and `export type` are excluded because they are erased and cost
 * nothing at runtime, and `await import(...)` is excluded because deferring an
 * import is one of the sanctioned fixes here.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(import.meta.dir, "..", "..", "src");

/**
 * Bare side-effect imports: `import "./x";`.
 */
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g;

/**
 * `import ... from "x"` and `export ... from "x"`, INCLUDING the multi-line
 * braced form, which is most of them in this codebase.
 *
 * The clause matcher is `[\s\S]*?`, not `[^;\n]*?`. An earlier version used the
 * latter and silently skipped every import whose specifier list wrapped onto its
 * own lines, which is the house style here: it reported `tools/search-scope` as
 * importing four modules when it imports five, and it would have missed a cycle
 * closed by any multi-line import. Non-greedy, so it stops at the FIRST `from`
 * clause and cannot run past the end of one statement into the next.
 *
 * `import type` / `export type` are excluded because they are erased and cost
 * nothing at runtime. `await import(...)` is excluded because deferring an import
 * is one of the sanctioned fixes here, and it genuinely does break the component:
 * the module is not instantiated until the call runs.
 */
const FROM_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type[\s{*])[\s\S]*?\sfrom\s*["']([^"']+)["']/g;

/** Every module specifier `source` imports at runtime. */
function specifiersIn(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) if (match[1]) found.push(match[1]);
	for (const match of source.matchAll(FROM_IMPORT_RE)) if (match[1]) found.push(match[1]);
	return found;
}

/** Resolve a relative specifier to a file on disk, or undefined for a package. */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

interface Graph {
	edges: Map<string, string[]>;
	moduleCount: number;
}

/** Every module statically reachable from `entry`, with its outgoing edges. */
function buildGraph(entry: string): Graph {
	const edges = new Map<string, string[]>();
	const stack = [path.resolve(entry)];
	while (stack.length > 0) {
		const file = stack.pop()!;
		if (edges.has(file)) continue;
		const out: string[] = [];
		for (const specifier of specifiersIn(fs.readFileSync(file, "utf-8"))) {
			const resolved = resolveSpecifier(file, specifier);
			if (resolved) out.push(resolved);
		}
		edges.set(file, out);
		stack.push(...out);
	}
	return { edges, moduleCount: edges.size };
}

/** Strongly connected components of size > 1, as repo-relative paths. */
function findCycles(graph: Graph): string[][] {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const cycles: string[][] = [];
	let counter = 0;

	// Iterative Tarjan: the graph runs to hundreds of modules and a recursive
	// walk would risk the stack on the deepest chains.
	for (const root of graph.edges.keys()) {
		if (index.has(root)) continue;
		const work: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }];
		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const { node } = frame;
			if (frame.edge === 0) {
				index.set(node, counter);
				low.set(node, counter);
				counter++;
				stack.push(node);
				onStack.add(node);
			}
			const children = graph.edges.get(node) ?? [];
			if (frame.edge < children.length) {
				const child = children[frame.edge]!;
				frame.edge++;
				if (!index.has(child)) work.push({ node: child, edge: 0 });
				else if (onStack.has(child)) low.set(node, Math.min(low.get(node)!, index.get(child)!));
			} else {
				if (low.get(node) === index.get(node)) {
					const component: string[] = [];
					let member: string;
					do {
						member = stack.pop()!;
						onStack.delete(member);
						component.push(path.relative(SRC, member));
					} while (member !== node);
					if (component.length > 1) cycles.push(component.sort());
				}
				work.pop();
				const parent = work[work.length - 1];
				if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(node)!));
			}
		}
	}
	return cycles;
}

/**
 * The entry points that are CLEAN and must stay clean. These are the hot ones:
 * `path-utils` and `config/settings` are imported for small things all over the
 * package, and `discovery` and `theme` sit under both.
 */
const ACYCLIC_ENTRIES = [
	["discovery", "discovery/index.ts"],
	["config/settings", "config/settings.ts"],
	["tools/path-utils", "tools/path-utils.ts"],
	["modes/theme/theme", "modes/theme/theme.ts"],
] as const;

/**
 * The entry points that are NOT clean yet, with the size of the largest cycle
 * still under each. A RATCHET, not a target: these numbers may only go down, and
 * a case here fails if a change makes a component bigger.
 *
 * They are recorded rather than quietly excluded because leaving them out of the
 * suite would read as "everything is acyclic", which is false. `internal-urls`
 * keeps an 8-module component among its protocol handlers and
 * `extensibility/skills`. `agent-session` keeps a 54-module one that runs through
 * `task/executor -> sdk.ts` and back out through the whole application, including
 * `main.ts` and the interactive UI: `sdk.ts` is the composition root and the task
 * executor legitimately needs it to spawn a subagent, so breaking that one means
 * injecting the session factory rather than moving a file, which is a larger
 * change than the two edges already cut.
 */
const RATCHETED_ENTRIES = [
	["internal-urls", "internal-urls/index.ts", 8],
	["session/agent-session", "session/agent-session.ts", 54],
] as const;

describe("hot import graphs are acyclic", () => {
	for (const [label, relative] of ACYCLIC_ENTRIES) {
		/**
		 * One case per entry point rather than one over all of them, so a failure
		 * names which graph regressed. The message prints the whole component,
		 * because the module a developer changed is rarely the one that reads as the
		 * cause: every member reports identical cost and any of them can be where the
		 * new edge went in.
		 */
		it(`has no import cycle under ${label}`, () => {
			const cycles = findCycles(buildGraph(path.join(SRC, relative)));

			expect(cycles).toEqual([]);
		});
	}

	for (const [label, relative, largest] of RATCHETED_ENTRIES) {
		/**
		 * The ratchet. Asserts the biggest remaining component under this entry is no
		 * bigger than it is today, so work that shrinks it is free and work that grows
		 * it fails here with the module list.
		 */
		it(`does not grow the largest import cycle under ${label} (currently ${largest})`, () => {
			const cycles = findCycles(buildGraph(path.join(SRC, relative)));
			const biggest = Math.max(0, ...cycles.map(cycle => cycle.length));

			expect(biggest).toBeLessThanOrEqual(largest);
		});
	}

	/**
	 * NON-VACUITY FOR EVERY CASE ABOVE. All of them assert an empty array, which is
	 * exactly what a broken graph builder returns too: a resolver that silently
	 * failed, a regex that matched nothing, or a wrong `SRC` would make this suite
	 * pass while checking nothing at all. This proves the graph is really being
	 * walked, and that the detector really finds a cycle when one exists.
	 */
	it("actually walks the graph and can still detect a cycle", () => {
		const graph = buildGraph(path.join(SRC, "discovery/index.ts"));

		// A real, sizeable graph, not one module and not zero.
		expect(graph.moduleCount).toBeGreaterThan(100);
		// And the detector is not simply returning nothing: fed a graph with a known
		// two-node cycle it reports it.
		const a = path.join(SRC, "a.ts");
		const b = path.join(SRC, "b.ts");
		const seeded: Graph = { edges: new Map([[a, [b]], [b, [a]]]), moduleCount: 2 };
		expect(findCycles(seeded)).toEqual([["a.ts", "b.ts"]]);
	});
});

describe("the specific edges that closed the two cycles stay gone", () => {
	/** The static specifiers this file imports. */
	function staticImports(relative: string): string[] {
		return specifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
	}

	/**
	 * The cycle check above would catch a straight reintroduction of this import,
	 * but this names the offending edge directly so the failure says what to undo
	 * rather than printing a 23-module component and leaving the reader to find the
	 * new line in it.
	 */
	it("keeps tools/path-utils out of internal-urls", () => {
		const imports = staticImports("tools/path-utils.ts");

		expect(imports.some(specifier => specifier.includes("internal-urls"))).toBe(false);
	});

	/** The same for the settings/theme edge, for the same reason. */
	it("keeps config/settings out of the theme barrel", () => {
		const imports = staticImports("config/settings.ts");

		expect(imports.some(specifier => specifier.includes("modes/theme/theme"))).toBe(false);
	});

	/**
	 * And the function that needed the router still exists where it moved to, with
	 * the import it moved for. Without this, deleting `search-scope.ts` outright
	 * would satisfy every assertion above.
	 */
	it("still resolves internal URLs, from tools/search-scope", () => {
		const imports = staticImports("tools/search-scope.ts");

		expect(imports).toContain("../internal-urls");
		expect(imports).toContain("./path-utils");
		expect(fs.readFileSync(path.join(SRC, "tools/search-scope.ts"), "utf-8")).toContain(
			"export async function resolveToolSearchScope",
		);
	});
});
