/**
 * Every text-primitive oracle can fail on an application that earns it.
 *
 * WHY THIS SUITE EXISTS:
 * A guarantee nobody has ever seen fail is not a guarantee, it is a line in a table. Three oracles in
 * this registry were wrong on their first run and every one of the three was wrong in a way a sweep of
 * correct behavior cannot show: the prefix check called `truncateToWidth(text, 1, Ellipsis.Ascii)`
 * a defect because the result is a single dot, part of a marker too wide to fit; the wrap checks
 * called a wrap into zero columns a defect, which has no correct answer; and the home-directory check
 * read the home path as a substring, so `/home/opextra/x` counted as painting `/home/op`. A crafted
 * defect per guarantee is what separates an oracle that reads its subject from one that cannot fire.
 *
 * WHAT IT ASSERTS:
 * A baseline application of every primitive fails nothing and is blind on nothing it should read.
 * Then `DEFECTS` is a `Record` over the guarantee union, so a guarantee with no crafted defect does
 * not compile, and each entry has to produce exactly that guarantee's failure and a message matching a
 * phrase of the branch it claims to exercise. The set of guarantees whose craft trips a second oracle
 * is pinned, because a craft that fires two checks is not proof that either one reads its own subject.
 *
 * The stand-down cases assert the third outcome: an application a guarantee says nothing about is
 * `skipped`, and one it applies to with nothing to read is `blind`, never a pass.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether the primitives are correct. That is the sweep, which drives every fixture at every width.
 * - A defect in `visibleWidth` itself. The oracles measure with the product's own function, so a
 *   measurement that is wrong everywhere is consistent everywhere. `styleBytesCostNoCells` catches the
 *   one case where it can be checked against itself.
 *
 * MUTATION GATE, run and recorded:
 * 1. Dropping the `width >= 1` scope from both wrap guarantees turns the zero-column stand-down red:
 *    a wrap into no columns is judged rather than declared out of scope.
 * 2. Returning `SHORT_ESCAPE` to the form that accepts any byte after ESC turns the severed-escape
 *    craft red: a truncated `ESC [ 1 ; 3` reads as a complete two-byte `ESC [`, and the guarantee can
 *    never fire. This was the first form written, and the craft is what caught it.
 * 3. Observed before the fix rather than as a re-injection: the prefix check stripped only a whole
 *    `...` or `…`, and nineteen of twenty fixtures failed it at width one, where the ASCII marker is a
 *    single dot. The home check read the home path as a substring, and `/home/opextra/x` counted as
 *    painting `/home/op`.
 */

import { describe, expect, it } from "bun:test";
import {
	evaluateAllTextPrimitiveOracles,
	TEXT_PRIMITIVE_ORACLE_GUARANTEES,
	type TextPrimitive,
	type TextPrimitiveOracleFrameState,
	type TextPrimitiveOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import { TEXT_FIXTURES, type TextPrimitiveCase, textPrimitiveStateFor } from "./helpers/defect-oracles";

/** A correct application of each primitive, driven through the real primitive. */
const BASELINES: Readonly<Record<TextPrimitive, TextPrimitiveCase>> = {
	truncate: {
		primitive: "truncate",
		fixture: "ascii",
		width: 20,
		ellipsis: "unicode",
		pad: false,
		strict: false,
		startColumn: 0,
	},
	wrap: {
		primitive: "wrap",
		fixture: "ascii",
		width: 13,
		ellipsis: "none",
		pad: false,
		strict: false,
		startColumn: 0,
	},
	slice: {
		primitive: "slice",
		fixture: "styled",
		width: 8,
		ellipsis: "none",
		pad: false,
		strict: true,
		startColumn: 2,
	},
	measure: {
		primitive: "measure",
		fixture: "styled",
		width: -1,
		ellipsis: "none",
		pad: false,
		strict: false,
		startColumn: 0,
	},
	expandTabs: {
		primitive: "expandTabs",
		fixture: "tabs",
		width: -1,
		ellipsis: "none",
		pad: false,
		strict: false,
		startColumn: 0,
	},
	shortenPath: {
		primitive: "shortenPath",
		fixture: "homePath",
		width: -1,
		ellipsis: "none",
		pad: false,
		strict: false,
		startColumn: 0,
	},
};

function baseline(primitive: TextPrimitive): TextPrimitiveOracleFrameState {
	return textPrimitiveStateFor(BASELINES[primitive]);
}

/**
 * A truncation whose result is the given row.
 *
 * `reappliedRow` moves with it, because idempotence is a claim about the row the truncation returned
 * and a craft that leaves the baseline's row there earns that guarantee's failure by accident.
 */
function truncated(row: string): TextPrimitiveOracleFrameState {
	return { ...baseline("truncate"), rows: [row], reappliedRow: row };
}

/** A crafted defect: the state it is built from, and a phrase of the branch it has to trip. */
interface CraftedDefect {
	build: () => TextPrimitiveOracleFrameState;
	phrase: RegExp;
}

/**
 * A `Record` over the guarantee union: a guarantee with no way to fail does not compile.
 *
 * Each craft starts from a real application and changes one thing, so the state stays a shape a
 * primitive could actually return.
 */
const DEFECTS: Readonly<Record<TextPrimitiveOracleGuarantee, CraftedDefect>> = {
	truncationFitsTheWidth: {
		// The whole input on one row: a prefix of itself, so the only guarantee it earns is the width.
		build: () => truncated(TEXT_FIXTURES.ascii),
		phrase: /past the 20 asked for/,
	},
	paddingReachesExactlyTheWidth: {
		build: () => ({ ...truncated("the qu"), pad: true }),
		phrase: /padded to 6 cells rather than exactly 20/,
	},
	truncationKeepsAPrefixOfTheInput: {
		build: () => truncated("the quick brown zebr"),
		phrase: /not a prefix of the input/,
	},
	truncationIsIdempotent: {
		build: () => ({ ...baseline("truncate"), reappliedRow: "something else entirely" }),
		phrase: /re-truncating the result changed it/,
	},
	everyWrappedRowFitsTheWidth: {
		// Every glyph of the input, on one row that does not fit: the width claim and nothing else.
		build: () => ({ ...baseline("wrap"), rows: [TEXT_FIXTURES.ascii] }),
		phrase: /row 0 is 43 cells wide/,
	},
	wrappingKeepsEveryVisibleGlyph: {
		// Rows that fit, carrying part of the input: the glyph claim and nothing else.
		build: () => ({ ...baseline("wrap"), rows: ["the quick", "brown fox"] }),
		phrase: /the input 3[0-9]/,
	},
	slicingStaysWithinTheLengthAsked: {
		build: () => ({ ...baseline("slice"), rows: ["a sliced row that runs well past eight cells"] }),
		phrase: /strict slice is 44 cells wide/,
	},
	noProducedRowCarriesALineBreak: {
		// On a slice, where the glyph-preservation claim does not apply, so the break is the only defect.
		build: () => ({ ...baseline("slice"), rows: ["ab\ncd"] }),
		phrase: /row 0 carries a line break/,
	},
	noProducedRowForwardsARawTab: {
		build: () => truncated("the qu\tick"),
		phrase: /row 0 forwards a raw tab/,
	},
	noEscapeSequenceIsCutInHalf: {
		build: () => ({ ...baseline("slice"), rows: ["styled \x1b[1;3"] }),
		phrase: /begins no complete sequence/,
	},
	styleBytesCostNoCells: {
		build: () => ({ ...baseline("measure"), measuredWidth: 40, measuredPlainWidth: 24 }),
		phrase: /40 cells styled and 24 unstyled/,
	},
	tabExpansionLeavesNoTab: {
		build: () => ({ ...baseline("expandTabs"), rows: ["col\tcol"] }),
		phrase: /still carries a tab/,
	},
	theHomeDirectoryIsNeverPainted: {
		build: () => ({ ...baseline("shortenPath"), rows: ["/home/oracle-operator/projects/x.ts"] }),
		phrase: /paints the home directory/,
	},
};

/** A guarantee whose craft also trips another oracle. Pinned, so a sloppy craft is a decision. */
const MULTI_TRIP_EXEMPTIONS: readonly TextPrimitiveOracleGuarantee[] = [];

describe("a correct application", () => {
	it.each((Object.keys(BASELINES) as readonly TextPrimitive[]).map(primitive => [primitive] as const))(
		"fails nothing: %s",
		primitive => {
			const verdict = evaluateAllTextPrimitiveOracles(baseline(primitive));
			expect(verdict.failures).toEqual([]);
		},
	);

	it("accounts for every guarantee in every baseline", () => {
		for (const primitive of Object.keys(BASELINES) as readonly TextPrimitive[]) {
			const verdict = evaluateAllTextPrimitiveOracles(baseline(primitive));
			const seen = [...verdict.skipped, ...verdict.inspected, ...verdict.blind].sort();
			expect(seen, primitive).toEqual([...TEXT_PRIMITIVE_ORACLE_GUARANTEES].sort());
		}
	});

	it("inspects every guarantee across the baselines", () => {
		const inspected = new Set<TextPrimitiveOracleGuarantee>();
		for (const primitive of Object.keys(BASELINES) as readonly TextPrimitive[]) {
			for (const guarantee of evaluateAllTextPrimitiveOracles(baseline(primitive)).inspected) {
				inspected.add(guarantee);
			}
		}
		// Padding is the one guarantee no baseline reads: every baseline truncation is unpadded, and a
		// padded one is a different application rather than a different assertion about this one.
		expect([...TEXT_PRIMITIVE_ORACLE_GUARANTEES].filter(guarantee => !inspected.has(guarantee))).toEqual([
			"paddingReachesExactlyTheWidth",
		]);
	});
});

describe("a crafted defect", () => {
	it.each(TEXT_PRIMITIVE_ORACLE_GUARANTEES.map(guarantee => [guarantee] as const))("is reported by %s", guarantee => {
		const verdict = evaluateAllTextPrimitiveOracles(DEFECTS[guarantee].build());
		const mine = verdict.failures.filter(failure => failure.oracle === guarantee);
		expect(mine.length, `${guarantee} reported ${verdict.failures.map(f => f.oracle).join(", ")}`).toBe(1);
		expect(mine[0].message).toMatch(DEFECTS[guarantee].phrase);
	});

	it("trips only its own oracle, apart from the pinned exemptions", () => {
		const multi: TextPrimitiveOracleGuarantee[] = [];
		for (const guarantee of TEXT_PRIMITIVE_ORACLE_GUARANTEES) {
			const verdict = evaluateAllTextPrimitiveOracles(DEFECTS[guarantee].build());
			if (verdict.failures.length > 1) multi.push(guarantee);
		}
		expect(multi).toEqual([...MULTI_TRIP_EXEMPTIONS]);
	});

	it("is inspected rather than skipped or blind", () => {
		for (const guarantee of TEXT_PRIMITIVE_ORACLE_GUARANTEES) {
			const verdict = evaluateAllTextPrimitiveOracles(DEFECTS[guarantee].build());
			expect(verdict.inspected, guarantee).toContain(guarantee);
		}
	});
});

describe("an application a guarantee says nothing about", () => {
	it("is skipped, not passed", () => {
		const verdict = evaluateAllTextPrimitiveOracles(baseline("shortenPath"));
		expect(verdict.skipped).toContain("everyWrappedRowFitsTheWidth");
		expect(verdict.skipped).toContain("truncationFitsTheWidth");
		expect(verdict.inspected).toContain("theHomeDirectoryIsNeverPainted");
	});

	it("is blind when it applies and there is nothing to read", () => {
		const noTabs = textPrimitiveStateFor({ ...BASELINES.expandTabs, fixture: "ascii" });
		const verdict = evaluateAllTextPrimitiveOracles(noTabs);
		expect(verdict.blind).toContain("tabExpansionLeavesNoTab");
		expect(verdict.failures).toEqual([]);
	});

	it("reads a path that is not under the home directory as untouched", () => {
		const lookalike = textPrimitiveStateFor({ ...BASELINES.shortenPath, fixture: "homeLookalike" });
		const verdict = evaluateAllTextPrimitiveOracles(lookalike);
		expect(verdict.inspected).toContain("theHomeDirectoryIsNeverPainted");
		expect(verdict.failures).toEqual([]);
	});

	it("declares a wrap into zero columns out of scope for both wrap guarantees", () => {
		const zero = textPrimitiveStateFor({ ...BASELINES.wrap, width: 0 });
		const verdict = evaluateAllTextPrimitiveOracles(zero);
		expect(verdict.skipped).toContain("everyWrappedRowFitsTheWidth");
		expect(verdict.skipped).toContain("wrappingKeepsEveryVisibleGlyph");
	});
});
