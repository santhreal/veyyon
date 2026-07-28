import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { collectPackageSourceFiles, PACKAGES_DIR } from "../../utils/test/support/package-sources";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";

/**
 * The thinking-effort ladder: its exact values, its exact order, and the rule
 * that `packages/catalog/src/effort.ts` is the only place any of it is written.
 *
 * Two separate contracts live here because they fail in opposite directions and
 * each is useless alone. The VALUES are a wire contract: `Effort.XHigh` is the
 * literal `"xhigh"` in a settings file a user has already written, in a model
 * spec's `thinking.efforts` array, and in the `reasoning_effort` field sent to
 * OpenAI-compatible servers, so renaming one is a silent break rather than a
 * compile error. The ORDER is an algorithmic contract: `canonicalizeEfforts`
 * documents that `clampThinkingLevelForModel` and `clampAutoThinkingEffort`
 * "break on the first entry past the request", which is correct only while the
 * list runs least to most intensive. Reversing two entries compiles, passes
 * every clamp test written against a specific model, and quietly caps every
 * request at the wrong level.
 *
 * The ownership half exists because the ladder was value-imported through the
 * `@veyyon/ai` barrel from about forty-six sites while `@veyyon/catalog/effort`
 * was the declared owner, and the disease that arrives with that is a second
 * declaration: `isEffort`'s own doc records both OpenAI-compatible servers in
 * `@veyyon/ai` having hand-written a chain of six `value === "..."` comparisons
 * instead of asking the owner, so adding a level to the ladder left each of them
 * silently rejecting it and a request naming the new effort was answered as
 * though it had named none. That is the failure this suite is here to make
 * impossible, and it is invisible to a behavioural test: a hand-rolled copy
 * agrees with the owner on the day it is written.
 */

const EXPECTED_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Source files this suite judges: production only, tests excluded. */
const SOURCES = await collectPackageSourceFiles({ dirs: ["src"] });

const TEXTS = new Map<string, string>(
	await Promise.all(SOURCES.map(async file => [file, await readFile(file, "utf8")] as const)),
);

function relative(file: string): string {
	return path.relative(PACKAGES_DIR, file);
}

/** Files whose text matches `pattern`, as paths relative to `packages/`. */
function filesMatching(pattern: RegExp): string[] {
	const hits: string[] = [];
	for (const [file, text] of TEXTS) {
		// A fresh regex per file: a `g` flag carries `lastIndex` between calls.
		if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) hits.push(relative(file));
	}
	return hits.sort();
}

describe("the effort ladder's values and order", () => {
	/**
	 * The six literals, spelled out rather than derived.
	 *
	 * Asserting `Effort.Minimal === Effort.Minimal` would prove nothing; these
	 * strings are what a user typed into `settings.json` and what a provider
	 * reads off the wire, so the expectation has to be written independently of
	 * the code that produces it. A rename shows up here as a diff a reviewer
	 * must approve, which is the only place the break is visible at all.
	 */
	it("spells each level exactly as it appears in settings and on the wire", () => {
		// Widened to `string` on purpose. `Effort` is a const enum, so each member's type is the
		// singleton `Effort.XHigh` rather than `"xhigh"`, and `toBe` would then demand the enum member
		// back, turning every one of these into `expect(Effort.XHigh).toBe(Effort.XHigh)`, which is
		// the tautology this test exists to avoid. Comparing as text is the wire contract.
		expect<string>(Effort.Minimal).toBe("minimal");
		expect<string>(Effort.Low).toBe("low");
		expect<string>(Effort.Medium).toBe("medium");
		expect<string>(Effort.High).toBe("high");
		expect<string>(Effort.XHigh).toBe("xhigh");
		expect<string>(Effort.Max).toBe("max");
	});

	/**
	 * The order is the contract, not merely the membership.
	 *
	 * `canonicalizeEfforts` promises least to most intensive and the clamp
	 * helpers stop at the first entry past the request, so a swapped pair caps
	 * requests at the wrong level with nothing raised. `toEqual` on the whole
	 * array is deliberate: a set-membership check would accept the swap.
	 */
	it("runs least to most intensive, as the clamp helpers require", () => {
		expect<readonly string[]>(THINKING_EFFORTS).toEqual([...EXPECTED_LADDER]);
	});

	/** Six levels, no duplicates: a paste that repeats one would still pass a membership check. */
	it("holds six distinct levels", () => {
		expect(THINKING_EFFORTS).toHaveLength(6);
		expect(new Set(THINKING_EFFORTS).size).toBe(6);
	});
});

describe("isEffort", () => {
	/** Every declared level is recognised; a guard that missed one would reject a valid request. */
	it("accepts every level on the ladder", () => {
		for (const level of EXPECTED_LADDER) expect(isEffort(level)).toBe(true);
	});

	/**
	 * The near-misses, which is where a hand-rolled guard goes wrong.
	 *
	 * `"Medium"` and `" high"` are what arrive from a settings file a user edited
	 * by hand, and `"none"`/`"off"` are what other tools call the absence of
	 * thinking. Each must be rejected rather than coerced, because a guard that
	 * accepts `"Medium"` sends a level no provider knows.
	 */
	it("rejects near-misses rather than coercing them", () => {
		for (const value of ["Medium", "MAX", " high", "high ", "", "none", "off", "xxhigh", "minimal2"]) {
			expect(isEffort(value)).toBe(false);
		}
	});

	/** Non-strings reach the guard from parsed JSON, so the typeof check has to hold. */
	it("rejects non-string inputs", () => {
		for (const value of [undefined, null, 0, 1, true, {}, [], ["high"], new String("high")]) {
			expect(isEffort(value)).toBe(false);
		}
	});
});

describe("canonicalizeEfforts", () => {
	/** A hand-authored spec may declare its ladder in any order; the result is always canonical. */
	it("restores canonical order from a scrambled ladder", () => {
		expect(canonicalizeEfforts([Effort.Max, Effort.Low, Effort.High, Effort.Minimal])).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.High,
			Effort.Max,
		]);
	});

	/** Duplicates collapse: the clamp walk would otherwise stop twice at the same level. */
	it("drops duplicates", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.High, Effort.Low, Effort.High])).toEqual([
			Effort.Low,
			Effort.High,
		]);
	});

	/** An empty ladder stays empty rather than defaulting to the full set. */
	it("returns nothing for an empty ladder", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});

	/** Only declared levels survive, so a spec naming an unknown level cannot smuggle it downstream. */
	it("filters out anything not on the ladder", () => {
		expect(canonicalizeEfforts(["ultra", Effort.Medium, "none"] as unknown as Effort[])).toEqual([Effort.Medium]);
	});

	/** The full ladder round-trips unchanged, which is the identity-derived case every model spec hits. */
	it("leaves an already-canonical ladder alone", () => {
		expect(canonicalizeEfforts([...THINKING_EFFORTS])).toEqual([...THINKING_EFFORTS]);
	});

	/** The input is not mutated: model specs share ladder arrays and a sort in place would corrupt them. */
	it("does not mutate its input", () => {
		const input = [Effort.Max, Effort.Low];
		canonicalizeEfforts(input);
		expect(input).toEqual([Effort.Max, Effort.Low]);
	});
});

describe("the ladder has exactly one declaration", () => {
	/**
	 * Guard on the guard.
	 *
	 * Every assertion below is "no file matches", which an empty file list
	 * satisfies. If the collector's skip-set or the packages layout ever moved,
	 * this suite would go green while scanning nothing, so the floor is asserted
	 * first and the ladder's own owner has to be among the files scanned.
	 */
	it("scans the tree it claims to scan", () => {
		expect(SOURCES.length).toBeGreaterThan(500);
		expect(filesMatching(/export const THINKING_EFFORTS/)).toEqual(["catalog/src/effort.ts"]);
	});

	/** One enum declaration. A second would make `Effort.High` mean two types that happen to agree today. */
	it("declares the Effort enum in the catalog and nowhere else", () => {
		expect(filesMatching(/^\s*export const enum Effort\b/m)).toEqual(["catalog/src/effort.ts"]);
	});

	/** One canonicalizer, because two would disagree the first time a level is inserted mid-ladder. */
	it("declares canonicalizeEfforts in the catalog and nowhere else", () => {
		expect(filesMatching(/^\s*export function canonicalizeEfforts\b/m)).toEqual(["catalog/src/effort.ts"]);
	});

	/**
	 * The literal form of the same duplicate, which a name-based lock cannot see.
	 *
	 * The copy that actually shipped was not called `THINKING_EFFORTS`; it was six
	 * inline `value === "..."` comparisons in two OpenAI-compatible servers. A
	 * second ladder is easy to write by accident and impossible to grep for by
	 * name, so this matches the SHAPE: the six literals in order inside one
	 * array. `effort.ts` itself is the sole legal match.
	 */
	it("does not restate the six levels as an array literal anywhere else", () => {
		const ladderLiteral =
			/\[\s*"minimal"\s*,\s*"low"\s*,\s*"medium"\s*,\s*"high"\s*,\s*"xhigh"\s*,\s*"max"\s*,?\s*\]/;
		expect(filesMatching(ladderLiteral)).toEqual([]);
	});
});

describe("production code takes the ladder from its owner", () => {
	/**
	 * A value import of `Effort`, `THINKING_EFFORTS` or `canonicalizeEfforts`
	 * through the `@veyyon/ai` barrel is banned in `src`; `import type` is not.
	 *
	 * `packages/ai/src/types.ts` re-exports `@veyyon/catalog/effort` on purpose
	 * and that stays: it is published API, and SDK consumers who take `Effort`
	 * from `@veyyon/ai` are entitled to keep doing so. What the barrel must not
	 * be is how this repository's own modules reach a catalog constant, because
	 * the barrel carries the streaming engine, every provider and the model
	 * catalogue behind it, so a six-entry ladder arrives with hundreds of modules
	 * attached. Type-only imports are erased before they can cost anything, which
	 * is why they remain legal and why this test reads the `type` keyword rather
	 * than the symbol name.
	 */
	it("never value-imports the ladder through the @veyyon/ai barrel", () => {
		const offenders: string[] = [];
		for (const [file, text] of TEXTS) {
			for (const match of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"@veyyon\/ai"/g)) {
				const [, typeOnlyImport, clause] = match;
				if (typeOnlyImport) continue;
				for (const specifier of clause.split(",")) {
					const trimmed = specifier.trim();
					if (trimmed.startsWith("type ")) continue;
					const name = trimmed.split(/\s+as\s+/)[0].trim();
					if (name === "Effort" || name === "THINKING_EFFORTS" || name === "canonicalizeEfforts") {
						offenders.push(`${relative(file)}: ${name}`);
					}
				}
			}
		}
		expect(offenders.sort()).toEqual([]);
	});

	/**
	 * The barrel re-export itself, pinned so its removal is a deliberate act.
	 *
	 * Dropping `export * from "@veyyon/catalog/effort"` from `ai/src/types.ts`
	 * looks like tidying once every internal caller has been repointed, and it
	 * would break published consumers with no deprecation. If it is ever to go,
	 * it goes with a migration path and this line edited to say so.
	 */
	it("keeps the @veyyon/ai re-export, which is published API", async () => {
		const types = await readFile(path.join(PACKAGES_DIR, "ai", "src", "types.ts"), "utf8");
		expect(types).toContain('export * from "@veyyon/catalog/effort";');
	});
});
