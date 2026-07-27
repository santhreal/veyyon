/**
 * Contract: the modules that only need a helper stop at the module that declares it.
 *
 * TWO EDGES, ONE SHAPE. Both were found by ranking import edges by MARGINAL cost, which is
 * `reach(file) - |{file} ∪ reach(every OTHER target of file)|`, rather than by how much a file
 * reaches in total. A reached total says nothing: cutting one of three paths to a heavy module moves
 * nothing, and a file that reaches 400 modules through an edge worth 5 is not the problem it looks
 * like.
 *
 *   - `diagnose.ts` runs schema and integrity checks over the database. It took `initBeam` from
 *     `core/beam`, the engine barrel, which reaches 402 modules: the recall path, consolidation, the
 *     episodic graph, the annotation store, the LLM tiers behind them. `initBeam` is declared in
 *     `core/beam/schema.ts`, which reaches ONE. 403 modules -> 92.
 *   - `core/local-llm.ts` took three runtime names and four types from the `@veyyon/ai` entry point
 *     in one clause. The entry point re-exports the package; the types are erased and free. 369 -> 306,
 *     and `core/extraction.ts` behind it 370 -> 307.
 *
 * WHY LOCAL-LLM KEEPS THE ENGINE, and why that is not a failure of the cut: it calls
 * `completeSimple`. A module that runs a completion has to load the thing that runs completions. What
 * changed is that `withAuth` and `assistantText` no longer arrive with the whole package attached.
 *
 * WHY A RATCHET. Nothing fails when either import comes back. The code works and the tests pass; only
 * cold start and the honesty of the graph move, so the numbers are pinned along with the specifiers,
 * because a count cannot say WHY a file grew and a specifier cannot catch a file that grew otherwise.
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

describe("the diagnostics run without the memory engine", () => {
	/** Measured at 92: the config, the database helpers, the datetime and sqlite utilities. */
	it("diagnose reaches at most 110 modules", () => {
		expect(reach("diagnose.ts")).toBeLessThanOrEqual(110);
	});

	/**
	 * The absences, NAMED rather than counted, because a ceiling cannot say which subsystem came
	 * back. Each of these is one import away and none of them is needed to ask whether a table exists.
	 */
	it("reaches none of the engine it used to carry", () => {
		const reached = reachedNames("diagnose.ts");

		expect(reached).not.toContain(path.join("packages", "mnemopi", "src", "core", "beam", "index.ts"));
		expect(reached).not.toContain(path.join("packages", "mnemopi", "src", "core", "beam", "recall.ts"));
		expect(reached).not.toContain(path.join("packages", "mnemopi", "src", "core", "extraction.ts"));
		expect(reached).not.toContain(path.join("packages", "ai", "src", "stream.ts"));
	});

	/**
	 * NON-VACUITY: the walk really resolved this module, so the absences above are a fact about the
	 * graph rather than what an unresolvable path gives for free. The schema owner is the edge that
	 * has to survive, since a diagnostic that cannot initialise a schema cannot check one.
	 */
	it("still reaches the schema owner it initialises with", () => {
		const reached = reachedNames("diagnose.ts");

		expect(reached).toContain(path.join("packages", "mnemopi", "src", "core", "beam", "schema.ts"));
		expect(reached.length).toBeGreaterThan(20);
	});

	/**
	 * Asserted as SPECIFIERS, which is the assertion that names the fix. `./core/beam` and
	 * `./core/beam/schema` export the same `initBeam` under the same name, compile identically and
	 * behave identically; they differ by 311 modules and nothing else here would notice the swap.
	 */
	it("names the schema owner and neither barrel", () => {
		const imports = runtimeImportsOf("diagnose.ts");

		expect(imports).toContain("./core/beam/schema");
		expect(imports).toContain("@veyyon/utils/type-guards");
		expect(imports).not.toContain("./core/beam");
		expect(imports).not.toContain("@veyyon/utils");
	});

	/**
	 * And it is the SAME function, compared by identity across the two spellings. A barrel that
	 * re-exported a different implementation would satisfy every case above and hand two callers
	 * different schemas, which is the one failure this cut must not introduce.
	 */
	it("the barrel and the owner export one function", async () => {
		const [barrel, owner] = await Promise.all([import("../src/core/beam"), import("../src/core/beam/schema")]);

		expect(barrel.initBeam).toBe(owner.initBeam);
	});
});

describe("asking whether a model is configured is not calling one", () => {
	/**
	 * THE CASCADE, pinned at every hop. `core/local-llm.ts` answered two questions in one module:
	 * configuration and prompt text, which is cheap, and the round trip through `completeSimple`,
	 * which is the streaming engine. `core/extraction.ts` asks the first kind on every path,
	 * `core/beam/consolidate.ts` sits behind extraction, and `core/beam/index.ts` sits behind
	 * consolidate, so one provider import was on the graph of every module that can remember
	 * something.
	 *
	 * Measured after the split: the config half 86, extraction 89 (from 307), consolidate 134 (331),
	 * the beam engine 144 (402 before any of today's cuts), the MCP server 148 (406). Every ceiling
	 * below is one of those, because a cut that held at the first hop and leaked at the third would
	 * be worth nothing and would pass a single-file check.
	 */
	it.each([
		["core/local-llm-config.ts", 100],
		["core/extraction.ts", 105],
		["core/beam/consolidate.ts", 150],
		["core/beam/index.ts", 160],
		["mcp-server.ts", 165],
	])("%s reaches at most %i modules", (relative, ceiling) => {
		expect(reach(relative)).toBeLessThanOrEqual(ceiling);
	});

	/** The calling half keeps the engine, because calling a model is what it is for. */
	it("local-llm reaches at most 320 modules", () => {
		expect(reach("core/local-llm.ts")).toBeLessThanOrEqual(320);
	});

	/**
	 * The absences that make the ceilings meaningful, NAMED. Extraction must not reach the engine or
	 * the calling half statically; if it does, the deferral was undone and only the number moved.
	 */
	it("extraction reaches neither the engine nor the calling half", () => {
		const reached = reachedNames("core/extraction.ts");

		expect(reached).not.toContain(path.join("packages", "ai", "src", "stream.ts"));
		expect(reached).not.toContain(path.join("packages", "mnemopi", "src", "core", "local-llm.ts"));
	});

	/**
	 * NON-VACUITY: it still reaches the CONFIG half, which is what it asks its questions of. Without
	 * this, deleting the import entirely would satisfy every absence above.
	 */
	it("extraction still reaches the configuration it reads", () => {
		expect(reachedNames("core/extraction.ts")).toContain(
			path.join("packages", "mnemopi", "src", "core", "local-llm-config.ts"),
		);
	});

	/**
	 * THE DEFERRAL ITSELF, by specifier, in both spellings. A reach count cannot tell a deferred edge
	 * from a deleted one, and `import(x)` and `import ... from x` name the same path, so the static
	 * form is asserted absent and the dynamic form present. Without the second half, a change that
	 * dropped the LLM call entirely would pass everything above.
	 */
	it("loads the calling half dynamically, and only dynamically", () => {
		const source = fs.readFileSync(path.join(SRC, "core", "extraction.ts"), "utf-8");

		expect(runtimeImportsOf("core/extraction.ts")).not.toContain("./local-llm");
		expect(source).toContain('import("./local-llm")');
		expect(source).toContain("llmClient()");
	});

	/**
	 * NON-VACUITY, and the case that keeps the ceiling honest: the engine is still reached, because
	 * this module calls it. A "cut" that lost `completeSimple` would pass the ceiling above and break
	 * every remote completion.
	 */
	it("still reaches the streaming engine it calls", () => {
		expect(reachedNames("core/local-llm.ts")).toContain(path.join("packages", "ai", "src", "stream.ts"));
	});

	/** The three owners named, and the entry point absent. */
	it("names three owners rather than the package entry point", () => {
		const imports = runtimeImportsOf("core/local-llm.ts");

		expect(imports).toContain("@veyyon/ai/stream");
		expect(imports).toContain("@veyyon/ai/auth-retry");
		expect(imports).toContain("@veyyon/ai/utils/message-text");
		expect(imports).not.toContain("@veyyon/ai");
	});

	/**
	 * The types still come from the entry point, on purpose: `import type` is erased at compile time,
	 * so the barrel is the right place to take a type from. This is what distinguishes a cut made by
	 * moving value imports from one made by deleting things.
	 */
	it("still takes its types from the entry point, which is free", () => {
		const source = fs.readFileSync(path.join(SRC, "core", "local-llm.ts"), "utf-8");

		expect(source).toContain('from "@veyyon/ai"');
		expect(source).toContain("FetchImpl");
	});
});
