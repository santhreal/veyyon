/**
 * The package's hot import graphs stay acyclic.
 *
 * WHY THIS SUITE EXISTS. A cycle is one strongly connected component and has to
 * be instantiated as a unit, so importing ANY member pulls in the whole component
 * and everything it reaches. Three of them had grown through this package, and
 * each let a module that should have been small drag in most of the codebase:
 *
 *   config/settings -> modes/theme/theme -> modes/theme/shimmer -> config/settings
 *
 *   tools/path-utils -> internal-urls -> internal-urls/skill-protocol ->
 *   extensibility/skills -> discovery -> discovery/builtin -> tools/path-utils
 *
 * The second pulled two dozen modules into one component, including `mcp/*`,
 * `lsp/utils` and `config.ts`. Every member of it measured identically, which is
 * the signature of a cycle: they were one thing wearing several names. Since
 * `path-utils` is imported for small helpers throughout the package, that reach
 * extended to nearly everything.
 *
 * A third, larger one ran through the composition root:
 *
 *   session/agent-session -> eval/py/executor -> eval/kernel-tool-bridge ->
 *   eval/js/tool-bridge -> eval/agent-bridge -> task/executor -> sdk ->
 *   session/agent-session
 *
 * That component held 54 modules, `main.ts` and the whole interactive UI among
 * them, so importing `agent-session` loaded the entire application. It was closed
 * by `eval/agent-bridge` naming `task/executor` statically, for the `agent()` helper
 * an eval cell can call. Those imports are deferred to the call now, so the task
 * layer loads when something actually spawns a subagent.
 *
 * Cutting the three shrank what each entry reaches: `path-utils` now reaches two
 * modules in total, `agent-session` 712 instead of 1120, and every entry point in
 * the tables below is acyclic.
 *
 * A CORRECTION WORTH KEEPING, because this suite was first written on the wrong
 * premise. It originally said the cycles were why a full test run was OOM-killed,
 * citing per-file memory costs of about 51 MB. Those were per-PROCESS measurements
 * generalised to a per-file cost, and the generalisation is wrong: a run puts every
 * file through one process, and bun caches the module registry across files. Files
 * importing the 710-module `agent-session` graph grow RSS by 1.70 MB each; files
 * importing nothing grow it by 1.68. The run still exhausts memory, for reasons
 * that have nothing to do with imports. What the cycles cost is architectural, not
 * memory, and that is reason enough to keep them out.
 *
 * WHAT THIS ASSERTS AND WHY IT IS STRUCTURAL. Each cycle was closed by ONE import
 * line, and each is a one-line change to reintroduce, with no failing behaviour to
 * catch it: everything still works, a leaf module just silently depends on the
 * whole package again. So this checks the graph itself. It resolves the real static import edges from source
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
 * The entry points that are CLEAN and must stay clean.
 *
 * There is no ratchet list any more, because there is nothing left to ratchet:
 * every entry point below is acyclic, including `session/agent-session`, which
 * used to sit on a 54-module component that reached `main.ts` and the whole
 * interactive UI. This list replaced it. If a cycle comes back, add the fix, not
 * a row saying the cycle is allowed.
 *
 * The hot ones are first: `path-utils` and `config/settings` are imported for
 * small things all over the package, and `discovery` and `theme` sit under both.
 * The rest are the modules the cycles used to run through, kept as entry points
 * so a regression is caught where it happens rather than in whatever imports it.
 */
const ACYCLIC_ENTRIES = [
	["discovery", "discovery/index.ts"],
	["config/settings", "config/settings.ts"],
	["tools/path-utils", "tools/path-utils.ts"],
	["modes/theme/theme", "modes/theme/theme.ts"],
	["config/model-registry", "config/model-registry.ts"],
	["config/model-resolver", "config/model-resolver.ts"],
	["internal-urls", "internal-urls/index.ts"],
	["session/agent-session", "session/agent-session.ts"],
] as const;

/**
 * How many modules each entry point drags in, with a ceiling. A RATCHET, same
 * rule: these may only go down.
 *
 * THIS IS AN ARCHITECTURE RATCHET, NOT A MEMORY ONE. An earlier version of this
 * comment claimed the count bounds peak RSS over a test run, citing per-file costs
 * of 7.8 MB for `path-utils` and 61.6 MB for `agent-session`. That was measured
 * wrong and the claim is withdrawn. Those are per-PROCESS costs, and a run puts
 * every file through ONE process, where bun caches the module registry across
 * files: 24 files that each import the 710-module `agent-session` graph grow RSS
 * by 1.70 MB per file, and 24 files that import nothing at all grow it by 1.68.
 * The graph is instantiated once, so its size is very nearly free per file.
 *
 * What the count does bound is what it literally measures: how much of the package
 * a module drags in. That is worth holding for its own sake. One convenient import
 * of a barrel can double a leaf module's reach, which slows a cold process start,
 * widens the blast radius of any change, and is how the cycles above got in. Read
 * a failure here as "this module now depends on far more than it used to", not as
 * "this will use more memory".
 *
 * The ceilings are today's counts plus a little slack, so ordinary work does not
 * trip them, and a change that adds a hundred modules to a hot path does.
 */
const GRAPH_SIZE_CEILINGS = [
	["config/auth-state", "config/auth-state.ts", 1],
	["config/model-resolver", "config/model-resolver.ts", 12],
	["tools/path-utils", "tools/path-utils.ts", 20],
	["config/settings", "config/settings.ts", 160],
	["modes/theme/theme", "modes/theme/theme.ts", 170],
	["tools/index", "tools/index.ts", 200],
	["config/model-registry", "config/model-registry.ts", 165],
	["discovery", "discovery/index.ts", 240],
	["internal-urls", "internal-urls/index.ts", 520],
	["session/agent-session", "session/agent-session.ts", 760],
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

	for (const [label, relative, ceiling] of GRAPH_SIZE_CEILINGS) {
		/**
		 * The size ratchet. A hot module that suddenly reaches hundreds more modules
		 * is the ordinary, non-cyclic way per-realm cost comes back, and the count is
		 * printed on failure so the diff that caused it is obvious.
		 */
		it(`does not grow the module graph under ${label} past ${ceiling}`, () => {
			const { moduleCount } = buildGraph(path.join(SRC, relative));

			expect(moduleCount).toBeLessThanOrEqual(ceiling);
		});
	}

	/**
	 * NON-VACUITY FOR EVERY CASE ABOVE. The cycle cases all assert an empty array,
	 * which is exactly what a broken graph builder returns too, and the ceilings are
	 * all upper bounds, which a builder that resolved nothing would satisfy trivially
	 * with a count of one. A resolver that silently failed, a regex that matched
	 * nothing, or a wrong `SRC` would make this whole suite pass while checking
	 * nothing at all. This proves the graph is really being walked, and that the
	 * detector really finds a cycle when one exists.
	 */
	it("actually walks the graph and can still detect a cycle", () => {
		const graph = buildGraph(path.join(SRC, "discovery/index.ts"));

		// A real, sizeable graph, not one module and not zero.
		expect(graph.moduleCount).toBeGreaterThan(100);
		// And the detector is not simply returning nothing: fed a graph with a known
		// two-node cycle it reports it.
		const a = path.join(SRC, "a.ts");
		const b = path.join(SRC, "b.ts");
		const seeded: Graph = {
			edges: new Map([
				[a, [b]],
				[b, [a]],
			]),
			moduleCount: 2,
		};
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
