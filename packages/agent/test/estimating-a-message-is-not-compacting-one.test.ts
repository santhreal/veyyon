/**
 * Contract: asking what a message costs does not load the machinery that compacts one.
 *
 * WHAT WAS WRONG. `estimateTokens` lived in `compaction/compaction.ts`, which is the compaction ENGINE: the
 * summarizer, the cut-point search and the provider round trip. It reaches 302 modules to do that job, and it
 * should. Estimating a message needs a tokenizer and nothing else.
 *
 * Three modules in the same directory wanted only the estimate, and the marginal cost of that one import was
 * the largest edge any of them had:
 *
 *   - `shake.ts` reached 398 modules, of which 312 were this edge.
 *   - `pruning.ts` reached 398, of which 197 were this edge.
 *   - `branch-summarization.ts` took the same edge, though it needs the rest of that graph anyway.
 *
 * The estimator now lives in `compaction/token-estimate.ts`, whose whole graph is the tokenizer, and
 * `compaction.ts` re-exports the name so no caller outside the directory changed.
 *
 * WHY A RATCHET AND NOT A BEHAVIOUR TEST. Nothing fails when this is undone. Every function keeps working,
 * every test keeps passing, and one import restores the mesh. What degrades is the cold start of everything
 * downstream and the honesty of the graph, so the number is what moves and the number is what is pinned,
 * together with the edges by name so a failure says what to undo instead of printing a count.
 *
 * WHY IT MATTERS BEYOND THE NUMBER. The estimate is not a display value: it decides when compaction triggers,
 * how pruning spends its budget and what the operator's context meter reads. Keeping it in a module anyone can
 * import cheaply is what lets those three callers agree on one implementation instead of growing their own.
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

/**
 * RE-MEASURED 2026-08-26 at 10, down from 92. `tokenizer.ts` took `estimateTokensFromText` from the
 * `@veyyon/utils` barrel, which put all 85 of that barrel's modules behind an estimate; it names
 * `@veyyon/utils/tokens` now. What remains is the native tokenizer binding, `@veyyon/utils/json` for
 * `stringifyJson`, and the archive module, which imports nothing at all — the test below pins that, so the
 * constant's home cannot grow a graph behind this ceiling.
 */
const TOKEN_ESTIMATE_CEILING = 12;

/** RE-MEASURED 2026-08-26 at 13, down from 88. Its own graph is the estimator plus a handful of local modules. */
const SHAKE_CEILING = 16;

/**
 * RE-MEASURED 2026-08-26 at 187, down from 204. It does not reach the ceiling above because it genuinely uses
 * more of the directory: the entry helpers, the message shapes and the read-selector split. 187 is that work,
 * not a leftover edge into the engine, which is why this ceiling is not "the same as shake".
 */
const PRUNING_CEILING = 195;

/**
 * The engine and the remote summarizer both took `ProviderHttpError` from the `@veyyon/ai/error` barrel,
 * which is 21 modules for one class. They name `@veyyon/ai/error/classes` now.
 *
 * RE-MEASURED 2026-08-26: engine 302, down from 316; remote summarizer 209, down from 223. These are not
 * leaf ceilings — the engine's graph is the job it does — but a ceiling here is what stops a barrel edge
 * from coming back, which is how those 14 got there.
 */
const COMPACTION_ENGINE_CEILING = 320;
const REMOTE_SUMMARIZER_CEILING = 216;

describe("the estimator is a leaf", () => {
	it(`token-estimate reaches at most ${TOKEN_ESTIMATE_CEILING} modules`, () => {
		expect(reach("compaction/token-estimate.ts")).toBeLessThanOrEqual(TOKEN_ESTIMATE_CEILING);
	});

	/**
	 * The absences, named rather than counted. Each is a subsystem an estimate has no business loading, and
	 * each is one import away from returning: the summarizer and the remote compaction client are both
	 * reachable from `compaction.ts`, which is exactly where this module used to live.
	 */
	it("reaches neither the compaction engine nor anything it talks to", () => {
		const reached = reachedNames("compaction/token-estimate.ts");

		expect(reached).not.toContain(path.join("packages", "agent", "src", "compaction", "compaction.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "compaction", "remote-summarizer.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "telemetry.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "prompts", "registry.ts"));
	});

	/**
	 * NON-VACUITY for the absences above: the walk really resolved this module, so "reaches none of those" is
	 * an answer about the graph and not what an empty set gives for free. The edges are named rather than
	 * counted, because a magnitude proxy stops meaning anything the moment the graph legitimately shrinks.
	 */
	it("still reaches the tokenizer, which is what an estimate is made of", () => {
		const reached = reachedNames("compaction/token-estimate.ts");

		expect(reached).toContain(path.join("packages", "agent", "src", "tokenizer.ts"));
		expect(reached).toContain(path.join("packages", "utils", "src", "tokens.ts"));
		expect(reached).toContain(path.join("packages", "natives", "native", "index.js"));
	});

	/**
	 * The one non-tokenizer sibling the estimator reaches is a constant with no graph of its own: its reach is
	 * itself. That is what keeps this ceiling a statement about the tokenizer, and an import added to the
	 * archive module fails here rather than spending the estimator's budget unnoticed.
	 */
	it("takes the legacy frame constant from a module that imports nothing", () => {
		expect(reachedNames("compaction/legacy-snapcompact-archive.ts")).toEqual([
			path.join("packages", "agent", "src", "compaction", "legacy-snapcompact-archive.ts"),
		]);
		expect(runtimeImportsOf("compaction/legacy-snapcompact-archive.ts")).toEqual([]);
	});

	/**
	 * It takes `stringifyJson` from the OWNER subpath, not the `@veyyon/utils` barrel.
	 *
	 * Asserted as the specifier because the two spellings compile identically and differ by 72 modules, which
	 * is most of this module's budget. A drive-by edit that reached for the barrel would cost more than the
	 * extraction saved and no other assertion here would move enough to notice.
	 */
	it("names the json owner rather than the utils barrel", () => {
		const imports = runtimeImportsOf("compaction/token-estimate.ts");

		expect(imports).toContain("@veyyon/utils/json");
		expect(imports).not.toContain("@veyyon/utils");
	});
});

describe("the three callers take the estimate from the leaf", () => {
	it(`shake reaches at most ${SHAKE_CEILING} modules`, () => {
		expect(reach("compaction/shake.ts")).toBeLessThanOrEqual(SHAKE_CEILING);
	});

	it(`pruning reaches at most ${PRUNING_CEILING} modules`, () => {
		expect(reach("compaction/pruning.ts")).toBeLessThanOrEqual(PRUNING_CEILING);
	});

	/**
	 * The edge itself, by specifier, for all three.
	 *
	 * This is the assertion that fails if someone puts the import back, and it is the useful one: the two
	 * spellings compile identically, behave identically, and differ by 312 modules for `shake.ts` alone.
	 * `branch-summarization.ts` is included even though its own ceiling would not move, because leaving one
	 * caller pointed at the engine is how the other two find their way back.
	 */
	it.each(["compaction/shake.ts", "compaction/pruning.ts", "compaction/branch-summarization.ts"])(
		"%s imports the estimate from ./token-estimate",
		relative => {
			const imports = runtimeImportsOf(relative);

			expect(imports).toContain("./token-estimate");
			expect(imports).not.toContain("./compaction");
		},
	);

	/** And neither of the two cut modules reaches the engine any more, which is the point of the ceilings. */
	it.each(["compaction/shake.ts", "compaction/pruning.ts"])("%s does not reach the compaction engine", relative => {
		expect(reachedNames(relative)).not.toContain(
			path.join("packages", "agent", "src", "compaction", "compaction.ts"),
		);
	});
});

describe("one error class does not cost an error barrel", () => {
	it(`the compaction engine reaches at most ${COMPACTION_ENGINE_CEILING} modules`, () => {
		expect(reach("compaction/compaction.ts")).toBeLessThanOrEqual(COMPACTION_ENGINE_CEILING);
	});

	it(`the remote summarizer reaches at most ${REMOTE_SUMMARIZER_CEILING} modules`, () => {
		expect(reach("compaction/remote-summarizer.ts")).toBeLessThanOrEqual(REMOTE_SUMMARIZER_CEILING);
	});

	/**
	 * Asserted as the specifier as well as the count, because the two spellings compile identically. The
	 * ceilings above are wide enough that one barrel edge returning would not necessarily break them, and
	 * this is the edge that put 14 modules behind a single `instanceof`.
	 */
	it.each(["compaction/compaction-helpers.ts", "compaction/remote-summarizer.ts"])(
		"%s names the error-class owner rather than the error barrel",
		relative => {
			const imports = runtimeImportsOf(relative);

			expect(imports).toContain("@veyyon/ai/error/classes");
			expect(imports).not.toContain("@veyyon/ai/error");
		},
	);
});

describe("the engine keeps the name its callers already import", () => {
	/**
	 * COMPATIBILITY. `estimateTokens` was a public name on `compaction.ts` before it moved, and modules
	 * outside this directory import it from there. The re-export is what makes the move invisible to them.
	 *
	 * Asserted by CALLING both spellings rather than by reading `compaction.ts` for an
	 * `export { estimateTokens } from "./token-estimate"` line. A re-export pointing at a second
	 * implementation reads identically in source and gives two callers different numbers, which is the
	 * failure this whole extraction was supposed to make impossible; function identity separates them.
	 */
	it("both spellings are the same function", async () => {
		const [fromEngine, fromLeaf] = await Promise.all([
			import("../src/compaction/compaction"),
			import("../src/compaction/token-estimate"),
		]);

		expect(fromEngine.estimateTokens).toBe(fromLeaf.estimateTokens);
	});
});
