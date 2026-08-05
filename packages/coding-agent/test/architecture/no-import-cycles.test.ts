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
 * A third, larger one ran through the composition root:
 *
 *   session/agent-session -> eval/py/executor -> eval/kernel-tool-bridge ->
 *   eval/js/tool-bridge -> eval/agent-bridge -> task/executor -> sdk ->
 *   session/agent-session
 *
 * That component held 54 modules, `main.ts` and the whole interactive UI among
 * them, which is why importing `agent-session` cost 91 MB. It was closed by
 * `eval/agent-bridge` naming `task/executor` statically, for the `agent()` helper
 * an eval cell can call. Those imports are deferred to the call now, so the task
 * layer loads when something actually spawns a subagent.
 *
 * Cutting the three moved the same numbers: `path-utils` 51.7 to 7.8 MB per file,
 * `config/settings` 51.4 to 15.6, `modes/theme/theme` 51.2 to 16.1, `discovery`
 * 51.5 to 44.0, `session/agent-session` 90.9 to 61.6. `path-utils` now reaches two
 * modules in total, `agent-session` 712 instead of 1120, and the graphs under
 * `discovery`, `config/settings`, `path-utils` and `theme` are acyclic.
 *
 * HOW TO MEASURE THIS, AND THE TRAP THAT WASTED A ROUND. Put N identical test
 * files somewhere and have each import one module, then read
 * `process.memoryUsage().rss` from a `--preload` as each file loads. The files
 * MUST live inside the workspace, and you MUST check that they passed. Copies
 * written to a scratch directory outside the repo cannot resolve
 * `@veyyon/coding-agent/*`, so every import fails, every file errors, and RSS
 * grows by the runner's own ~1.7 MB per file. Read without the pass/fail line that
 * looks exactly like proof that imports are free, and it is how this comment
 * briefly acquired a "correction" claiming the memory story was wrong. Measured
 * properly, from `packages/coding-agent/node_modules/`: six files that each import
 * `session/agent-session` take RSS from 43 MB to 529 MB, and a heap snapshot at the
 * end holds 8,937 `ModuleRecord`s, about 1,490 per file, one full copy of the graph
 * for every realm.
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
import { resolveToolSearchScope } from "@veyyon/coding-agent/tools/search-scope";
import { moduleGraph, moduleSpecifiersIn, resolveModuleSpecifier } from "@veyyon/utils/module-reach";

const SRC = path.join(import.meta.dir, "..", "..", "src");

/**
 * Bare side-effect imports: `import "./x";`.
 */
/**
 * THE WALK IS NOT DEFINED HERE. `@veyyon/utils/module-reach` owns the specifier extraction and the
 * resolution, and `packages/utils/test/module-reach.test.ts` tests both against fixtures with known
 * answers. This file had its own copy, and so did three other architecture gates, each resolving a
 * slightly different set of specifiers.
 *
 * A cycle gate is as blind to an under-resolving walker as a ceiling is, and in the same direction: a
 * missing resolution rule is a missing EDGE, a missing edge is a path that does not exist, and a cycle
 * through it reads as absent. Nothing fails. So the resolver is shared and tested where it can be
 * caught, and what stays here is what belongs to this gate: Tarjan, the entry points, the ceilings.
 *
 * `import type` and `export type` are excluded because they are erased and cost nothing at runtime, and
 * `await import(...)` is excluded because deferring an import is one of the sanctioned fixes here. Both
 * exclusions live in the shared walk, so this gate and the reach ratchets cannot disagree about what an
 * import is.
 *
 * NO RESOLUTION IS PASSED, on purpose. This measures THIS package's internal graph: a cycle has to run
 * through `packages/coding-agent/src` to be one this gate can act on, and pulling `@veyyon/utils` into
 * every count would bury the numbers the ceilings are set from.
 */

interface Graph {
	edges: Map<string, string[]>;
	moduleCount: number;
}

/** Every module statically reachable from `entry`, with its outgoing edges. */
function buildGraph(entry: string): Graph {
	const edges = moduleGraph(entry);
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
	// Added after a full runner pass failed six chunks with two errors of one shape:
	// `Export named 'formatOutputNotice' not found in module tools/output-meta.ts` and
	// `Export named 'wrapSteeringForModel' not found in module session/messages.ts`. Both
	// names exist in the source, and a name that is present at rest and absent at
	// resolution time is what a re-export through a module caught mid-initialization looks
	// like. The failure reached the operator, not just the test: `veyyon token` and
	// `veyyon usage` printed the SyntaxError where their own output belonged. These four
	// entries are the graphs those two modules sit in.
	["session/messages", "session/messages.ts"],
	["session/steering-envelope", "session/steering-envelope.ts"],
	["tools/output-meta", "tools/output-meta.ts"],
	["tools/output-notice", "tools/output-notice.ts"],
] as const;

/**
 * How many modules each entry point drags in, with a ceiling. A RATCHET, same
 * rule: these may only go down.
 *
 * WHY COUNT MODULES RATHER THAN MEASURE MEMORY. What actually needs bounding is
 * peak RSS over a full test run, and the direct way to bound it is to run the
 * whole suite under `/usr/bin/time -v` and check the peak. That takes minutes and
 * cannot run in a unit test, so nothing would run it and the ceiling would be
 * rediscovered the next time the suite grew. The reachable module count is the
 * thing peak RSS is proportional to, it is deterministic, and it costs
 * milliseconds. The measurements line up: `path-utils` at 2 modules costs 7.8 MB
 * per file, `discovery` at 211 costs 44.0, `agent-session` at 712 costs 61.6.
 *
 * A cycle is the pathological way this number grows, and the cases above already
 * cover that. This catches the ordinary way: one convenient import of a barrel
 * that quietly doubles what a module pulls in. Both were happening here.
 *
 * The ceilings are today's counts plus a little slack, so ordinary work does not
 * trip them, and a change that adds a hundred modules to a hot path does.
 */
/**
 * RE-RATCHETED 2026-07-26, and the reason is that most of these had stopped guarding anything.
 *
 * Every ceiling here was set right after the cut that motivated it, and then the graphs kept shrinking
 * as later cuts landed while the numbers stayed where they were. Measured against reality:
 * `config/settings` was 36 against a ceiling of 160, `tools/index` 65 against 200,
 * `config/model-registry` 49 against 165, `tools/plan-mode-guard` 47 against 160, `discovery` 110
 * against 240, `tools/path-utils` 2 against 20. A ceiling at four times the real number permits a
 * module to quadruple its graph without failing, which is the same outcome as deleting the row: the
 * gate is green either way and nobody looks. Leaving a ratchet loose after a real reduction is exactly
 * the move the header warns against, just spread over several changes instead of one.
 *
 * Each is now `measured + roughly ten to fifteen percent`, rounded, with the measurement recorded next
 * to it. That is room for a handful of ordinary imports and no room for a new subtree. When one fails,
 * the fix is essentially always to import from the owning leaf rather than from a barrel; raising the
 * number is the move that guarantees nobody looks again.
 */
const GRAPH_SIZE_CEILINGS = [
	// Measured 2026-07-26 at 1. Exact on purpose: it reads a file and holds no dependency.
	["config/auth-state", "config/auth-state.ts", 1],
	// Measured 2026-07-26 at 7.
	["config/model-resolver", "config/model-resolver.ts", 10],
	// Measured 2026-07-26 at 2, down from the 51-MB-per-realm component it used to sit inside. This is
	// the module imported for small helpers throughout the package, so it is the most leveraged number
	// in the list.
	["tools/path-utils", "tools/path-utils.ts", 6],
	// Measured 2026-07-26 at 36, down from 139 when the light/dark classifier left
	// `modes/theme/builtin-themes` for `modes/theme/theme-luminance` and stopped dragging one JSON
	// module per bundled theme. ~1,500 test files import `Settings`, so this is the second most
	// leveraged.
	["config/settings", "config/settings.ts", 45],
	// Measured 2026-07-26 at 145. The engine legitimately owns the theme JSON.
	["modes/theme/theme", "modes/theme/theme.ts", 160],
	// Measured 2026-07-26 at 65.
	["tools/index", "tools/index.ts", 80],
	// Measured 2026-07-26 at 49.
	["config/model-registry", "config/model-registry.ts", 60],
	// Measured 2026-07-26 at 110.
	["discovery", "discovery/index.ts", 130],
	// Measured 2026-07-26 at 488. Close to its ceiling already, and the protocol registry is inherent.
	["internal-urls", "internal-urls/index.ts", 500],
	// Measured 2026-07-26 at 595. The composition root, so it reaches most of the package by design.
	["session/agent-session", "session/agent-session.ts", 610],
	// The five modules the barrel-import sweep made cheap. Each one is here because it was
	// hundreds of modules for a reason that had nothing to do with what it does, and because the
	// regression is invisible without a number: `import { resolveLocalRoot } from "../internal-urls"`
	// is the obvious line to write and costs the whole protocol registry, while
	// `from "../internal-urls/local-protocol"` costs seven. Prefer the owning leaf over a barrel
	// whenever the barrel is a FEATURE rather than a namespace.
	// Measured 2026-07-26 at 7, against the whole protocol registry it used to cost.
	["internal-urls/local-protocol", "internal-urls/local-protocol.ts", 12],
	// Measured 2026-07-26 at 8.
	["eval/backend", "eval/backend.ts", 12],
	// Measured 2026-07-26 at 18.
	["eval/js/tool-bridge", "eval/js/tool-bridge.ts", 25],
	// Measured 2026-07-26 at 47.
	["tools/plan-mode-guard", "tools/plan-mode-guard.ts", 60],
	// Measured 2026-07-26 at 183.
	["utils/image-vision-fallback", "utils/image-vision-fallback.ts", 200],
	// Measured 2026-07-26 at 199.
	["lsp/index", "lsp/index.ts", 215],
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
		//
		// LOWERED from 100 to 50, measured at 80 on 2026-07-26. The probe genuinely shrank rather than the
		// walk breaking: `discovery/claude.ts` and `discovery/opencode.ts` read two settings each and had
		// imported `config/settings.ts`, the 95-module store that loads `config.yml` and opens `agent.db`,
		// to do it. They read `config/settings-instance.ts` now, which owns the slot and imports nothing.
		//
		// The floor is deliberately well under the current number rather than pinned just below it. This
		// case exists to prove the graph is really walked, and a floor tracking the measurement would turn a
		// non-vacuity check into a second ceiling that every honest cut has to come back and edit.
		expect(graph.moduleCount).toBeGreaterThan(50);
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

describe("the graph is this package's own, which is what the ceilings are set from", () => {
	/**
	 * WHY THIS EXISTS. `buildGraph` calls the shared walk with NO resolution, and that single omission
	 * decides what every number in this file means. With no resolution, a specifier that is not relative
	 * resolves to nothing, so the walk stops at this package's edge and each ceiling counts modules under
	 * `packages/coding-agent/src` only.
	 *
	 * Hand a resolution table to the same call and every count jumps by the whole of `@veyyon/utils`,
	 * `@veyyon/ai` and the rest. Two things then break at once: every ceiling here is suddenly wrong in a
	 * direction that reads as a real regression, and Tarjan starts reporting components that run through
	 * other packages, which this gate cannot act on and whose fix does not live here. The test asserts the
	 * resolver's behaviour at the seam rather than trusting the prose above it.
	 */
	it("resolves nothing outside this package, because no resolution table is passed", () => {
		const settings = path.join(SRC, "config/settings.ts");

		expect(resolveModuleSpecifier(settings, "@veyyon/utils")).toBeUndefined();
		expect(resolveModuleSpecifier(settings, "@veyyon/utils/dirs")).toBeUndefined();
		expect(resolveModuleSpecifier(settings, "@veyyon/ai")).toBeUndefined();
		expect(resolveModuleSpecifier(settings, "node:fs")).toBeUndefined();
	});

	/**
	 * And the other half of the same contract: a RELATIVE specifier does resolve, to the absolute path of
	 * the file it names. If this stopped working the graph would collapse to one node per entry, every
	 * ceiling would pass by a mile, and the cycle search would have nothing to search.
	 */
	it("resolves a relative specifier to the file it names", () => {
		const settings = path.join(SRC, "config/settings.ts");

		expect(resolveModuleSpecifier(settings, "../modes/theme/theme-luminance")).toBe(
			path.join(SRC, "modes/theme/theme-luminance.ts"),
		);
	});

	/**
	 * A CEILING IS AN UPPER BOUND, so it is blind in exactly one direction: it stays green when the walk
	 * under-resolves and reports less than reality. That is not hypothetical here. Every ceiling in
	 * `GRAPH_SIZE_CEILINGS` was re-measured on 2026-07-26 and most had drifted to three or four times the
	 * real graph, which permits a module to quadruple its imports without failing. This case pins the
	 * smallest entry in the list exactly, so an under-resolving walk fails somewhere instead of quietly
	 * lowering every number at once.
	 */
	it("counts config/auth-state as exactly one module, its own", () => {
		expect(buildGraph(path.join(SRC, "config/auth-state.ts")).moduleCount).toBe(1);
	});
});

describe("the specific edges that closed the two cycles stay gone", () => {
	/** The static specifiers this file imports. */
	function staticImports(relative: string): string[] {
		return moduleSpecifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
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

	/**
	 * The same for the settings/theme edge, for the same reason.
	 *
	 * EXACT specifiers, not a substring. `includes("modes/theme/theme")` also matches
	 * `modes/theme/theme-luminance`, which is the classifier leaf settings is SUPPOSED to import: it
	 * carries the light/dark answer as a table so settings does not drag the hundred embedded theme
	 * JSON modules for one boolean. A substring test failed the moment that leaf was named, reporting
	 * the cycle was back when the opposite had happened. The same collision existed in
	 * `test/config/settings-theme-decoupling.test.ts` and is fixed the same way there.
	 */
	it("keeps config/settings out of the theme barrel", () => {
		const imports = staticImports("config/settings.ts");

		expect(imports).not.toContain("../modes/theme/theme");
		expect(imports).not.toContain("../modes/theme/shimmer");
		expect(imports).not.toContain("../modes/theme/theme-class");
		// And the leaf it does import, so this is not satisfied by settings dropping the classifier.
		expect(imports).toContain("../modes/theme/theme-luminance");
	});

	/**
	 * Locks out: deleting `tools/search-scope.ts` outright, which would satisfy every absence above.
	 * The function that needed the router still lives there and still names it.
	 *
	 * Asserted by importing the module and checking the export, not by searching its text for
	 * `export async function resolveToolSearchScope`. A text search passes on a comment carrying the
	 * name and fails when the same function is exported as a const arrow, so it tests the spelling
	 * rather than the surface.
	 */
	it("still resolves internal URLs, from tools/search-scope", () => {
		const imports = staticImports("tools/search-scope.ts");

		expect(imports).toContain("../internal-urls");
		expect(imports).toContain("./path-utils");
		expect(typeof resolveToolSearchScope).toBe("function");
	});
});
