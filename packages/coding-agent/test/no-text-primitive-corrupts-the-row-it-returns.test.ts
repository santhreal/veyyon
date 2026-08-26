/**
 * No text primitive corrupts the row it returns.
 *
 * WHY THIS SUITE EXISTS:
 * Every row the product paints has been through a truncation, a wrap, a slice or a width measurement,
 * and the TUI sanitization rules require a renderer to call them rather than measure text itself. A
 * defect in one of the four is a defect in every surface at once, and none of the surface oracles can
 * attribute it: they see a corrupted row and blame the renderer that forwarded it.
 *
 * WHAT IT ASSERTS:
 * The sweep drives every fixture through every primitive at every width, with the option axes each
 * primitive actually takes, and judges each application against the whole registry. It then makes its
 * claims separately, so one failure does not mask another:
 *
 * - No application throws. A primitive that cannot survive a lone combining mark or a ZWJ cluster is a
 *   crash in a renderer, and a suite that only checked the rows would never reach the assertion.
 * - The offenders of each guarantee are exactly the ones on the ledger, by exact equality of
 *   `primitive/fixture` pairs. The two live defect fields are real: `truncateToWidth` and
 *   `wrapTextWithAnsi` both measure a tab as a stop's worth of cells and forward the raw byte, so a
 *   row that came out of either still jumps the cursor unless the caller expanded tabs first; and a
 *   wrap into one column drops a NUL. A total instead of a set would let a new offender hide behind a
 *   fixed one.
 * - Every guarantee is inspected somewhere in the sweep, so a guarantee that has quietly stopped
 *   applying to anything cannot sit in the registry looking like coverage.
 * - Every blind verdict is explained. The blind-capable guarantees are pinned as a set, and each one
 *   carries a reason read from the application rather than from the check under test: a guarantee that
 *   goes blind for a reason nobody recorded turns this red.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether `visibleWidth` agrees with a terminal emulator's own width table. The oracles measure with
 *   the product's own function, so a measurement wrong everywhere is consistent everywhere. The grid
 *   oracles, which read a real Ghostty screen, are what see that.
 * - A defect that needs two applications to appear, such as a wrap whose rows a later truncation
 *   corrupts. Each state here is one application.
 * - An input nobody thought of. The fixtures are the shapes that have broken a width somewhere; the
 *   space of strings is not swept.
 *
 * MUTATION GATE, run and recorded:
 * 1. Measuring a row with `text.length` instead of `visibleWidth` in the runner turns four of these
 *    red, the width and slice ledgers among them: a styled row's escape bytes count as cells.
 * 2. Dropping `truncate/leadingTab` and `truncate/tabs` from the tab ledger turns that ledger red. The
 *    ledger is the set, not a count, so a fix to the primitive edits it and a new offender cannot take
 *    a fixed one's place.
 */

import { describe, expect, it } from "bun:test";
import {
	plainText,
	TEXT_PRIMITIVE_ORACLE_GUARANTEES,
	type TextPrimitiveOracleFrameState,
	type TextPrimitiveOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import {
	evaluateTextPrimitiveCase,
	promoteTextPrimitiveFailureToCorpus,
	TEXT_FIXTURES,
	TEXT_WIDTHS,
	type TextPrimitiveCase,
	textPrimitiveCases,
	textPrimitiveStateFor,
} from "./helpers/defect-oracles";

/**
 * What the primitives forward today, as `primitive/fixture` pairs.
 *
 * Deliberately blind to which width and which ellipsis tripped each one: the pair is the defect, and
 * pinning every arm would turn a fix into a hundred-line edit. Each entry is a defect in the
 * primitive, not in the oracle. Removing one requires the primitive to stop doing it.
 */
const KNOWN_OFFENDERS: Readonly<Record<TextPrimitiveOracleGuarantee, readonly string[]>> = {
	truncationFitsTheWidth: [],
	paddingReachesExactlyTheWidth: [],
	truncationKeepsAPrefixOfTheInput: [],
	truncationIsIdempotent: [],
	everyWrappedRowFitsTheWidth: [],
	// A wrap into a single column drops a NUL rather than carrying it to a row of its own.
	wrappingKeepsEveryVisibleGlyph: ["wrap/controlBytes"],
	slicingStaysWithinTheLengthAsked: [],
	noProducedRowCarriesALineBreak: [],
	// Both primitives measure a tab as a stop's worth of cells and forward the raw byte. A caller that
	// has not already run the expansion gets a row whose cursor jumps past what the layout allotted.
	noProducedRowForwardsARawTab: ["truncate/leadingTab", "truncate/tabs", "wrap/leadingTab", "wrap/tabs"],
	noEscapeSequenceIsCutInHalf: [],
	styleBytesCostNoCells: [],
	tabExpansionLeavesNoTab: [],
	theHomeDirectoryIsNeverPainted: [],
};

/**
 * Why a guarantee is allowed to read nothing, read from the application rather than from the check.
 *
 * A guarantee absent from this table is asserted never blind. One present has to be blind only for its
 * own reason, so an oracle that stops applying for a new reason turns this red instead of looking like
 * coverage.
 */
const BLIND_REASONS: Readonly<
	Partial<Record<TextPrimitiveOracleGuarantee, (state: TextPrimitiveOracleFrameState) => boolean>>
> = {
	paddingReachesExactlyTheWidth: state => !state.pad,
	truncationKeepsAPrefixOfTheInput: state => plainText(state.rows[0] ?? "").trim() === "",
	truncationIsIdempotent: state => /[\n\r]/.test(state.input),
	wrappingKeepsEveryVisibleGlyph: state => state.input === "",
	noProducedRowCarriesALineBreak: state => state.primitive !== "wrap" && /[\n\r]/.test(state.input),
	noEscapeSequenceIsCutInHalf: state => state.rows.every(row => !row.includes("\x1b")),
	styleBytesCostNoCells: state => state.input === "",
	tabExpansionLeavesNoTab: state => !state.input.includes("\t"),
};

interface SweepResult {
	cases: readonly TextPrimitiveCase[];
	threw: readonly string[];
	offenders: ReadonlyMap<TextPrimitiveOracleGuarantee, ReadonlySet<string>>;
	inspectedSomewhere: ReadonlySet<TextPrimitiveOracleGuarantee>;
	unexplainedBlind: readonly string[];
	firstMessages: ReadonlyMap<TextPrimitiveOracleGuarantee, string>;
}

function sweep(): SweepResult {
	const cases = textPrimitiveCases();
	const threw: string[] = [];
	const offenders = new Map<TextPrimitiveOracleGuarantee, Set<string>>();
	const inspectedSomewhere = new Set<TextPrimitiveOracleGuarantee>();
	const unexplainedBlind: string[] = [];
	const firstMessages = new Map<TextPrimitiveOracleGuarantee, string>();
	const promoted = new Set<TextPrimitiveOracleGuarantee>();
	for (const guarantee of TEXT_PRIMITIVE_ORACLE_GUARANTEES) offenders.set(guarantee, new Set());

	for (const spec of cases) {
		const pair = `${spec.primitive}/${spec.fixture}`;
		let state: TextPrimitiveOracleFrameState;
		try {
			state = textPrimitiveStateFor(spec);
		} catch (error) {
			threw.push(`${pair} at width ${spec.width}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const verdict = evaluateTextPrimitiveCase(spec);
		for (const guarantee of verdict.inspected) inspectedSomewhere.add(guarantee);
		for (const guarantee of verdict.blind) {
			const reason = BLIND_REASONS[guarantee];
			if (!reason?.(state)) unexplainedBlind.push(`${guarantee} on ${pair} at width ${spec.width}`);
		}
		for (const failure of verdict.failures) {
			offenders.get(failure.oracle)?.add(pair);
			if (!firstMessages.has(failure.oracle)) firstMessages.set(failure.oracle, failure.message);
			// One case per guarantee: a defect in a primitive fails hundreds of applications, and a
			// corpus of hundreds of copies of it reproduces nothing more than one does.
			if (promoted.has(failure.oracle)) continue;
			promoted.add(failure.oracle);
			promoteTextPrimitiveFailureToCorpus(spec, failure, state.rows, { template: "text-primitive-sweep" });
		}
	}
	return { cases, threw, offenders, inspectedSomewhere, unexplainedBlind, firstMessages };
}

const result = sweep();

describe("the sweep drove the space it claims", () => {
	it("drove every fixture through every primitive", () => {
		const pairs = new Set(result.cases.map(spec => `${spec.primitive}/${spec.fixture}`));
		expect(pairs.size).toBe(Object.keys(TEXT_FIXTURES).length * 6);
	});

	it("drove every width the axis declares", () => {
		const widths = new Set(result.cases.filter(spec => spec.width >= 0).map(spec => spec.width));
		expect([...widths].sort((left, right) => left - right)).toEqual([...TEXT_WIDTHS]);
	});

	it("reached a verdict for every guarantee somewhere in the sweep", () => {
		expect(TEXT_PRIMITIVE_ORACLE_GUARANTEES.filter(guarantee => !result.inspectedSomewhere.has(guarantee))).toEqual(
			[],
		);
	});
});

describe("no primitive crashes on hostile text", () => {
	it("returns rows for every application it was asked for", () => {
		expect(result.threw).toEqual([]);
	});
});

describe("what the primitives forward today", () => {
	it.each(TEXT_PRIMITIVE_ORACLE_GUARANTEES.map(guarantee => [guarantee] as const))(
		"%s: the offenders are exactly the ones on the ledger",
		guarantee => {
			const observed = [...(result.offenders.get(guarantee) ?? [])].sort();
			expect(observed, result.firstMessages.get(guarantee) ?? "no failure observed").toEqual(
				[...KNOWN_OFFENDERS[guarantee]].sort(),
			);
		},
	);

	it("found something to record, so the ledger is not vacuous", () => {
		const total = TEXT_PRIMITIVE_ORACLE_GUARANTEES.reduce(
			(sum, guarantee) => sum + (result.offenders.get(guarantee)?.size ?? 0),
			0,
		);
		expect(total).toBeGreaterThan(0);
	});
});

describe("a blind verdict is explained", () => {
	it("is blind only for its own recorded reason", () => {
		expect(result.unexplainedBlind).toEqual([]);
	});

	it("names every guarantee that can be blind, and no other", () => {
		const everBlind = new Set<TextPrimitiveOracleGuarantee>();
		for (const spec of result.cases) {
			for (const guarantee of evaluateTextPrimitiveCase(spec).blind) everBlind.add(guarantee);
		}
		const declared = Object.keys(BLIND_REASONS) as TextPrimitiveOracleGuarantee[];
		expect([...everBlind].sort()).toEqual(declared.sort());
	});
});
