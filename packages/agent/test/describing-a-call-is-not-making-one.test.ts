/**
 * Contract: importing a span attribute does not import a model provider.
 *
 * WHAT `telemetry.ts` IS. Span vocabulary. Attribute names, span lifecycles, status mapping, the run
 * collector, the aggregators. Every symbol in it describes work that some other module does, and it is
 * imported all over this package by code that will never call a model: the run summary, the tool
 * status enum, the OTEL attribute constants.
 *
 * WHAT IT ALSO HELD. `instrumentedCompleteSimple`, the one helper in the file that RUNS a completion.
 * It names `completeSimple`, and `completeSimple` is the streaming engine, so every consumer of an
 * attribute constant loaded the provider stack, the model catalogue and the error taxonomy to get it.
 * Measured: `telemetry.ts` reached 366 modules, of which 281 were that single import. It propagated
 * exactly as far as you would expect, because compaction imports telemetry: `branch-summarization.ts`
 * paid 190 modules for it.
 *
 * THE SPLIT IS BY WHAT A MODULE DOES. Describing a call and making one are different jobs, and only
 * one of them needs a provider. `telemetry.ts` reaches 9 modules now; `instrumented-complete.ts`
 * reaches 305, and it should, because a module that runs a completion has to load the thing that runs
 * completions.
 *
 * WHY A RATCHET. Nothing fails when the import comes back. Every function keeps working and every
 * test keeps passing. What degrades is cold start for everything downstream and the honesty of the
 * graph, so the number is what is pinned, together with the edges by name so a failure says what to
 * undo rather than printing a count.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
	moduleSpecifiersIn,
	typeOnlyModuleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

function reachedNames(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)]
		.map(file => path.relative(REPO_ROOT, file))
		.sort();
}

function runtimeImportsOf(relative: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
}

/**
 * Measured at 9: the OTEL API, the run collector, and the two owner modules the file takes one
 * runtime name from each. The ceiling sits close because there is nothing left to lose; a jump of any
 * size here means a value import came back.
 */
const TELEMETRY_CEILING = 20;

/** Measured at 305. It runs a completion, so the engine is its work, not an accident. */
const INSTRUMENTED_CEILING = 320;

describe("the span vocabulary is a leaf", () => {
	it(`telemetry reaches at most ${TELEMETRY_CEILING} modules`, () => {
		expect(reach("telemetry.ts")).toBeLessThanOrEqual(TELEMETRY_CEILING);
	});

	/**
	 * The absences, NAMED. Each is a subsystem that describing a call has no business loading, and
	 * each is one import away: `stream.ts` is what the extracted helper calls, and the provider and
	 * the model registry sit behind it.
	 */
	it("reaches neither the streaming engine nor a provider", () => {
		const reached = reachedNames("telemetry.ts");

		expect(reached).not.toContain(path.join("packages", "ai", "src", "stream.ts"));
		expect(reached).not.toContain(path.join("packages", "ai", "src", "index.ts"));
		expect(reached).not.toContain(path.join("packages", "ai", "src", "providers", "anthropic.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "instrumented-complete.ts"));
	});

	/**
	 * NON-VACUITY for the absences: the walk really resolved this module. The run collector is the
	 * one substantial thing telemetry does reach, because aggregating a run is part of describing it.
	 */
	it("still reaches the run collector, which is part of its job", () => {
		const reached = reachedNames("telemetry.ts");

		expect(reached).toContain(path.join("packages", "agent", "src", "run-collector.ts"));
		expect(reached.length).toBeGreaterThan(3);
	});

	/**
	 * The two runtime names it does take come from OWNER modules, asserted as specifiers.
	 *
	 * Both spellings compile and behave identically and each differs by hundreds of modules:
	 * `@veyyon/ai` re-exports the engine, `@veyyon/utils` re-exports 74 modules for one stringifier.
	 * No other assertion here would notice a drive-by edit to either.
	 */
	it("names the owners rather than the two barrels", () => {
		const imports = runtimeImportsOf("telemetry.ts");

		expect(imports).toContain("@veyyon/ai/types");
		expect(imports).toContain("@veyyon/utils/json");
		expect(imports).not.toContain("@veyyon/ai");
		expect(imports).not.toContain("@veyyon/utils");
	});

	/**
	 * And it still takes its TYPES from `@veyyon/ai`, which is free and is the point of the
	 * distinction. A cut made by deleting the types would satisfy every case above and would have
	 * been a different, worse change.
	 */
	it("still takes its types from the package it describes", () => {
		const source = fs.readFileSync(path.join(SRC, "telemetry.ts"), "utf-8");

		// Both halves, because the scan this replaced only had the first one and got it backwards:
		// `toContain('from "@veyyon/ai"')` is satisfied by a RUNTIME import, which is precisely the
		// world "which is free" exists to forbid.
		expect(typeOnlyModuleSpecifiersIn(source)).toContain("@veyyon/ai");
		expect(moduleSpecifiersIn(source)).not.toContain("@veyyon/ai");
	});
});

describe("the helper that makes a call owns the engine", () => {
	it(`instrumented-complete reaches at most ${INSTRUMENTED_CEILING} modules`, () => {
		expect(reach("instrumented-complete.ts")).toBeLessThanOrEqual(INSTRUMENTED_CEILING);
	});

	/**
	 * NON-VACUITY, and the case that makes the whole split meaningful: the engine did not disappear,
	 * it moved to the module whose job needs it. A "cut" that lost the completion would pass every
	 * ceiling here.
	 */
	it("really does reach the streaming engine", () => {
		expect(reachedNames("instrumented-complete.ts")).toContain(path.join("packages", "ai", "src", "stream.ts"));
	});

	/** It names `stream.ts` directly rather than the package entry point, for the usual 60 modules. */
	it("names the stream owner rather than the barrel", () => {
		const imports = runtimeImportsOf("instrumented-complete.ts");

		expect(imports).toContain("@veyyon/ai/stream");
		expect(imports).not.toContain("@veyyon/ai");
	});

	/**
	 * NO RE-EXPORT FROM `telemetry.ts`, asserted rather than assumed.
	 *
	 * This is the compatibility shim the two previous extractions in this package both used, and it
	 * is deliberately absent here: `instrumented-complete.ts` imports `telemetry.ts`, so a re-export
	 * would close a cycle between them. The name stays public through the package entry point
	 * instead, which is where every consumer outside this package already took it from.
	 */
	it("telemetry does not re-export it, because that would be a cycle", () => {
		const source = fs.readFileSync(path.join(SRC, "telemetry.ts"), "utf-8");

		expect(source).not.toContain("instrumented-complete");
		expect(runtimeImportsOf("instrumented-complete.ts")).toContain("./telemetry");
	});
});

describe("the public name did not move", () => {
	/**
	 * COMPATIBILITY. Four modules in `@veyyon/coding-agent` import `instrumentedCompleteSimple` from
	 * `@veyyon/agent-core`, and two of them are spied on by name in tests. The entry point re-export
	 * is what keeps all of that working, so it is asserted at the entry point rather than inferred
	 * from the extraction having compiled.
	 */
	it("the package entry point still exports it", async () => {
		const entry = await import("../src/index");

		expect(typeof entry.instrumentedCompleteSimple).toBe("function");
	});

	/**
	 * And it is the SAME function the owner declares, compared by identity. A second implementation
	 * behind the same name would satisfy the case above and hand two callers different behaviour,
	 * which is the failure every extraction in this package is supposed to make impossible.
	 */
	it("and it is the function the owner declares", async () => {
		const [entry, owner] = await Promise.all([import("../src/index"), import("../src/instrumented-complete")]);

		expect(entry.instrumentedCompleteSimple).toBe(owner.instrumentedCompleteSimple);
	});

	/**
	 * The two in-package callers import from the OWNER, not from `../telemetry`. Asserted as the
	 * specifier: `../telemetry` no longer exports the name, so this would fail to compile today, but
	 * it would start compiling again the moment somebody restored a convenience re-export.
	 */
	it.each(["compaction/compaction.ts", "compaction/branch-summarization.ts"])(
		"%s imports it from the owner",
		relative => {
			const imports = runtimeImportsOf(relative);

			expect(imports).toContain("../instrumented-complete");
		},
	);
});
