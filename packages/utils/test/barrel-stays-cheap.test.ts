/**
 * `@veyyon/utils` stays cheap to import, and the vendored diagram renderer stays out of it.
 *
 * WHY THIS SUITE EXISTS. 664 test files import this barrel, which makes it the most leveraged
 * import in the repository: whatever it reaches, most of the workspace declares a dependency on.
 * It reached the vendored Mermaid ASCII renderer, 35 modules, because of a single
 * `export * from "./mermaid-ascii"` -- a third of everything the barrel touched, for a symbol with
 * exactly ONE consumer. Removing it took the barrel from 109 modules to 74, and `@veyyon/tui` and
 * `@veyyon/ai` fell from 146 to 111 and from 335 to 300 without either package changing.
 *
 * The ceiling is the assertion because nothing else fails when that regresses. The renderer would
 * work and every test would pass; what degrades is the honesty of the dependency graph, the cold
 * start of everything that imports the barrel, and the ease of closing an import cycle by accident.
 *
 * This is an architecture gate first. `packages/coding-agent/test/architecture/test-suite-module-reach.test.ts`
 * explains what was measured on 2026-07-26, and the answer depends on how the suite is run: under
 * bun's default parallelism a run costs the UNION of what its files reach, which is small, but under
 * `--parallel=1` workspace source is re-instantiated per file and never freed, so it costs the SUM
 * and a wider barrel really does multiply. Keep it narrow for the dependency graph; that it also
 * bounds a `--parallel=1` run is a second reason, not the first.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleReach, moduleSpecifiersIn, resolveModuleSpecifier } from "@veyyon/utils/module-reach";

const SRC = path.join(import.meta.dir, "..", "src");
const BARREL = path.join(SRC, "index.ts");

/**
 * THE WALK IS NOT DEFINED HERE. It used to be, and so did a near-identical copy in
 * `packages/coding-agent/test/architecture/test-suite-module-reach.test.ts`, and the two did not
 * resolve the same things. Both gates are upper bounds, so a resolver that resolves less reports a
 * smaller number and the gate passes while measuring less than it claims. `@veyyon/utils/module-reach`
 * owns it now and `packages/utils/test/module-reach.test.ts` tests it against fixtures with known
 * answers, which is the only place that under-counting can be caught.
 *
 * No resolution is passed on purpose: this measures the barrel's own graph, and every file in it is
 * reached relatively. A bare `@veyyon/utils` inside `@veyyon/utils` would be a cycle, not a cost.
 */
const reachable = moduleReach(BARREL);

/**
 * RE-MEASURED 2026-07-26 at 82, which is this ceiling exactly, so it is now a strict ratchet with no
 * headroom at all: the next module on the barrel's graph fails this test until someone raises the number
 * deliberately and records why. That is intentional. Six hundred realms multiply this number.
 *
 * It read 74 for two reasons, and only one of them was growth. Applying a user's `.env` split into two
 * phases and added three modules the barrel genuinely reaches (`dotenv-home.ts`, `dotenv-parse.ts`,
 * `dir-env-keys.ts`). The rest was a measurement bug in the walk: `moduleSpecifiersIn` let a non-re-export
 * `export` statement run forward to the next `from "…"` in the file and swallow every real import in
 * between, so some of the barrel's own edges were never examined. This gate is an upper bound, so the
 * hidden ones passed. See `packages/utils/test/module-reach-reads-code-not-prose.test.ts`.
 *
 * IF YOU ARE HERE BECAUSE THIS FAILED: the failure message lists every module the barrel reaches. Check
 * first whether the new import belongs on the barrel at all, or whether the consumer that needed it should
 * name the owning module by subpath, which is what every other reach gate in this repository pushes toward.
 */
const BARREL_CEILING = 82;

describe("the @veyyon/utils barrel", () => {
	/** The number that multiplies by six hundred realms. */
	it(`reaches at most ${BARREL_CEILING} modules`, () => {
		const names = [...reachable].map(file => path.relative(SRC, file)).sort();

		expect(reachable.size, `modules reachable from the barrel:\n${names.join("\n")}`).toBeLessThanOrEqual(
			BARREL_CEILING,
		);
	});

	/**
	 * The specific subtree that was removed, named so a re-added `export *` fails with the reason
	 * rather than with an opaque count. Callers import `@veyyon/utils/mermaid-ascii` instead.
	 */
	it("does not drag the vendored Mermaid renderer", () => {
		const vendored = [...reachable].filter(file => file.includes(`${path.sep}vendor${path.sep}mermaid-ascii`));

		expect(
			vendored.map(file => path.relative(SRC, file)),
			"the vendored diagram renderer is back in the barrel — import @veyyon/utils/mermaid-ascii instead",
		).toEqual([]);
	});

	/**
	 * NON-VACUITY. Both assertions above are satisfied by a resolver that finds nothing, which is
	 * exactly what a broken specifier regex would produce. These pin that the walk really happened
	 * and that the renderer is still reachable by its own path, so the second case is testing where
	 * the code lives rather than whether it exists.
	 */
	it("actually walks the graph it is measuring", () => {
		expect(reachable.size).toBeGreaterThan(50);
		expect([...reachable].some(file => file.endsWith(`${path.sep}logger.ts`))).toBe(true);

		const direct = moduleReach(path.join(SRC, "mermaid-ascii.ts"));
		expect(direct.size).toBeGreaterThan(30);
	});

	/**
	 * The walk's inputs, checked here rather than trusted, because this gate now depends on a helper in
	 * another module. If `moduleSpecifiersIn` stopped seeing a re-export, or `resolveModuleSpecifier`
	 * stopped resolving a relative path, the ceiling above would pass with a number near one and say
	 * nothing. `module-reach.test.ts` covers the helper in full; these two lines are the seam.
	 */
	it("reads the barrel through a walk that can see its edges", () => {
		const barrelSource = fs.readFileSync(BARREL, "utf-8");
		const specifiers = moduleSpecifiersIn(barrelSource);

		expect(specifiers.length).toBeGreaterThan(20);
		expect(resolveModuleSpecifier(BARREL, "./logger")).toBe(path.join(SRC, "logger.ts"));
	});
});
