/**
 * Veracity is one vocabulary, and the five things that went wrong when it was five.
 *
 * WHY THIS SUITE EXISTS. Veracity decides whether a memory comes back, and it was declared
 * five times in this package with different value sets. That alone is a style complaint; what
 * made it a bug is WHICH copy validated writes. `core/veracity-consolidation.ts` knew five
 * values and owned `clampVeracity`, while `core/beam/recall.ts` privately knew eight and did
 * the scoring, and `core/beam/store.ts` privately knew seven and clamped every `remember()`.
 *
 * Each test below pins one reproduction taken before the fix, with the real number it
 * returned, because every one of them is silent: nothing threw, nothing logged, and the
 * memory was simply ranked as though it had said something different about itself.
 *
 *   1. `clampVeracity("false")` was `"unknown"`. A memory recorded as known-wrong came back
 *      weighted 0.8 instead of 0, which is most of the way to being retrieved normally. This
 *      is the one that matters: the point of storing `false` is that it stops surfacing.
 *   2. `clampVeracity("true")` and `"likely_true"` were `"unknown"`, demoting a confirmed
 *      fact from 1.0 to 0.8.
 *   3. `aggregateVeracity(["true", "true"])` was `"unknown"`, because the guard filtered
 *      both inputs out before counting them.
 *   4. `store.ts` clamped `likely_true` away with no warning at all, so the one write path
 *      most callers use silently disagreed with the type that permitted the value.
 *   5. `contested` was a member of the nine-value union in `core/beam/types.ts` that no
 *      producer wrote and no weight table scored, and recall's
 *      `?? VERACITY_WEIGHTS.unknown ?? 0.8` chain gave it an unlabelled memory's weight.
 *
 * The structural tests at the end are what stop the five copies from coming back: they prove
 * the vocabulary, the weights, and the allow-list are one list rather than three that happen
 * to agree today.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	aggregateVeracity,
	clampVeracity,
	isVeracity,
	resetVeracityWarnings,
	VERACITY_ALLOWED,
	VERACITY_DESCRIPTION,
	VERACITY_MEANINGS,
	VERACITY_VALUES,
	VERACITY_WEIGHTS,
	weightForVeracity,
} from "../src/core/veracity";

beforeEach(() => {
	// The warn-once memory is module state. Without this, the first suite to clamp a value
	// silences every later assertion that clamping is reported.
	resetVeracityWarnings();
});

describe("the vocabulary the package writes", () => {
	it("holds the eight values that have a producer in the tree", () => {
		// Not a count check: the list itself, so adding a value is a visible decision and
		// removing one that something writes fails here rather than at recall.
		expect([...VERACITY_VALUES].sort()).toEqual([
			"false",
			"imported",
			"inferred",
			"likely_true",
			"stated",
			"tool",
			"true",
			"unknown",
		]);
	});

	it("does not admit `contested`, which nothing ever wrote", () => {
		// It was a member of the nine-value union in `core/beam/types.ts` and appeared nowhere
		// else: no producer, no weight, no document. Admitting it bought a silent clamp, and a
		// value the package cannot produce is not a state.
		expect(isVeracity("contested")).toBe(false);
		expect(VERACITY_VALUES).not.toContain("contested");
	});

	it("weighs every value it admits, so the read path needs no default", () => {
		// The `?? VERACITY_WEIGHTS.unknown ?? 0.8` chain in recall existed because its table
		// and the union disagreed. Exhaustiveness is what removed the chain.
		for (const value of VERACITY_VALUES) {
			expect(typeof VERACITY_WEIGHTS[value], `${value} has no weight`).toBe("number");
		}
		expect(Object.keys(VERACITY_WEIGHTS).sort()).toEqual([...VERACITY_VALUES].sort());
	});

	it("explains every value it admits, because the MCP schema hands the list to a model", () => {
		for (const value of VERACITY_VALUES) {
			expect(VERACITY_MEANINGS[value].length, `${value} has no meaning`).toBeGreaterThan(10);
		}
		expect(Object.keys(VERACITY_MEANINGS).sort()).toEqual([...VERACITY_VALUES].sort());
	});

	it("keeps the allow-list and the weights the same list, not two that agree today", () => {
		// `VERACITY_ALLOWED` used to restate the five keys a second time in the same file. It
		// is derived now, and this is what fails if someone writes it out again.
		expect(Object.keys(VERACITY_ALLOWED).sort()).toEqual([...VERACITY_VALUES].sort());
		for (const value of VERACITY_VALUES) expect(VERACITY_ALLOWED[value]).toBe(true);
	});

	it("names every value in the generated description a tool schema shows a model", () => {
		for (const value of VERACITY_VALUES) {
			expect(VERACITY_DESCRIPTION, `${value} is not described`).toContain(value);
			expect(VERACITY_DESCRIPTION).toContain(VERACITY_MEANINGS[value]);
		}
	});
});

describe("the weights, which decide what comes back", () => {
	it("keeps a known-false memory out of results rather than ranking it low", () => {
		// Zero, not a small number. Recall multiplies the score by this, so any positive value
		// leaves a memory something checked and rejected competing with the rest.
		expect(VERACITY_WEIGHTS.false).toBe(0);
		expect(weightForVeracity("false")).toBe(0);
	});

	it("scores a confirmed fact above an unlabelled one", () => {
		// The bug ran the other way: `true` was clamped to `unknown`, so these were equal.
		expect(weightForVeracity("true")).toBe(1.0);
		expect(weightForVeracity("likely_true")).toBe(1.0);
		expect(weightForVeracity("stated")).toBe(1.0);
		expect(weightForVeracity("unknown")).toBe(0.8);
		expect(weightForVeracity("true")).toBeGreaterThan(weightForVeracity("unknown"));
	});

	it("keeps the five weights consolidation already knew", () => {
		// Merging the vocabularies had to be additive. These five were live in stored data
		// before the fix, and changing any of them would silently re-rank an existing store.
		expect(VERACITY_WEIGHTS.stated).toBe(1.0);
		expect(VERACITY_WEIGHTS.unknown).toBe(0.8);
		expect(VERACITY_WEIGHTS.inferred).toBe(0.7);
		expect(VERACITY_WEIGHTS.imported).toBe(0.6);
		expect(VERACITY_WEIGHTS.tool).toBe(0.5);
	});

	it("orders the whole vocabulary the way the labels claim", () => {
		expect(weightForVeracity("stated")).toBeGreaterThan(weightForVeracity("inferred"));
		expect(weightForVeracity("inferred")).toBeGreaterThan(weightForVeracity("imported"));
		expect(weightForVeracity("imported")).toBeGreaterThan(weightForVeracity("tool"));
		expect(weightForVeracity("tool")).toBeGreaterThan(weightForVeracity("false"));
	});
});

describe("clamping a value on its way in", () => {
	it("keeps `false`, which it used to rewrite to `unknown`", () => {
		// THE reproduction. Before the fix this returned "unknown" and the memory was scored
		// 0.8 instead of 0, so a fact the system had checked and rejected kept surfacing.
		expect(clampVeracity("false")).toBe("false");
	});

	it("keeps `true` and `likely_true`, which it used to rewrite to `unknown`", () => {
		expect(clampVeracity("true")).toBe("true");
		expect(clampVeracity("likely_true")).toBe("likely_true");
	});

	it("keeps the five consolidation already accepted", () => {
		expect(clampVeracity("stated")).toBe("stated");
		expect(clampVeracity("inferred")).toBe("inferred");
		expect(clampVeracity("tool")).toBe("tool");
		expect(clampVeracity("imported")).toBe("imported");
		expect(clampVeracity("unknown")).toBe("unknown");
	});

	it("treats case and surrounding space as the noise they are", () => {
		// Values arrive from hand-written config and from other stores, where "STATED" is the
		// same intent as "stated".
		expect(clampVeracity("STATED")).toBe("stated");
		expect(clampVeracity("  Likely_True  ")).toBe("likely_true");
		expect(clampVeracity("TRUE")).toBe("true");
	});

	it("reads an absent value as unlabelled", () => {
		expect(clampVeracity(null)).toBe("unknown");
		expect(clampVeracity(undefined)).toBe("unknown");
		expect(clampVeracity("")).toBe("unknown");
		expect(clampVeracity("   ")).toBe("unknown");
	});

	it("does not accept an inherited property as a veracity", () => {
		// `Object.hasOwn`, not a plain index. A bare lookup finds `Object.prototype.toString`
		// and comes back with a truthy function, which is how the prompt registry's `require`
		// managed to return a prototype method for the id "toString".
		expect(isVeracity("toString")).toBe(false);
		expect(isVeracity("constructor")).toBe(false);
		expect(clampVeracity("toString")).toBe("unknown");
		expect(clampVeracity("constructor")).toBe("unknown");
	});

	it("names the value it did not recognize, rather than clamping in silence", () => {
		// The clamp decides whether a memory comes back. `store.ts`'s copy made the same
		// decision with no output at all, so a caller passing `likely_true` to `remember()`
		// had nothing to read that said the label had been discarded.
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(clampVeracity("tru", "remember")).toBe("unknown");

			expect(warn).toHaveBeenCalledTimes(1);
			const line = String(warn.mock.calls[0][0]);
			expect(line).toContain("remember");
			expect(line).toContain('"tru"');
			expect(line).toContain("clamping to 'unknown'");
		} finally {
			warn.mockRestore();
		}
	});

	it("says it once per distinct value, so a legacy store does not bury the message", () => {
		// Recall calls this per candidate per query. Repeating the same line thousands of
		// times is loud in the wrong sense: the operator scrolls past the one thing they
		// needed to read. Distinct values still each get a line.
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (let index = 0; index < 50; index += 1) clampVeracity("tru");
			expect(warn).toHaveBeenCalledTimes(1);

			clampVeracity("mostly");
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn about a value the package writes itself", () => {
		// Before the fix every `true`/`false`/`likely_true` write printed a warning about a
		// value this package stores, which taught operators to ignore the message.
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const value of VERACITY_VALUES) clampVeracity(value);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("aggregating the veracities of memories being consolidated into one", () => {
	it("carries `true` through, where it used to return `unknown`", () => {
		// The guard filtered both inputs out before counting, so consolidating two confirmed
		// sources produced an unlabelled fact.
		expect(aggregateVeracity(["true", "true"])).toBe("true");
		expect(aggregateVeracity(["false"])).toBe("false");
		expect(aggregateVeracity(["likely_true", "likely_true"])).toBe("likely_true");
	});

	it("lets the most common value win", () => {
		expect(aggregateVeracity(["stated", "stated", "inferred"])).toBe("stated");
		expect(aggregateVeracity(["inferred", "tool", "tool"])).toBe("tool");
	});

	it("ignores unlabelled sources while anything else is present", () => {
		// An unlabelled duplicate is an absence of evidence, not evidence of absence, so it
		// must not outvote the one source that said something.
		expect(aggregateVeracity(["unknown", "unknown", "stated"])).toBe("stated");
	});

	it("reads unlabelled only when that is all there is", () => {
		expect(aggregateVeracity(["unknown", "unknown"])).toBe("unknown");
		expect(aggregateVeracity([])).toBe("unknown");
		expect(aggregateVeracity(null)).toBe("unknown");
		expect(aggregateVeracity(undefined)).toBe("unknown");
	});

	it("breaks a tie toward the lower weight, so `false` beats `true`", () => {
		// A claim something checked and rejected is not settled by a claim something else
		// accepted, and the conservative reading is the one that keeps a wrong memory out of
		// results. This is why the tie-break reads the weights rather than key order.
		expect(aggregateVeracity(["true", "false"])).toBe("false");
		expect(aggregateVeracity(["stated", "tool"])).toBe("tool");
	});

	it("drops an unrecognized value instead of clamping it into a vote", () => {
		// Clamping here would add `unknown` votes that could outnumber the real ones and
		// decide the outcome, which is a different answer than ignoring noise.
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(aggregateVeracity(["stated", "nonsense", "nonsense"])).toBe("stated");
		} finally {
			warn.mockRestore();
		}
	});
});
