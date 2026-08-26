/**
 * WHY THIS SUITE EXISTS:
 * The markdown component is where a wrap, a cache and a lexer meet, and it is reached from thirty-four
 * call sites with whatever text a model produced. A row wider than the terminal, a row carrying a line
 * break, a severed escape sequence or a cache that hands one width's rows to another width all corrupt
 * the frame, and none of them is visible in a test that renders one string once.
 *
 * WHAT IT ASSERTS:
 * Every source the runner drives, at every width and both paddings, against all nine guarantees. The
 * ledgers are pinned by exact equality and are empty: the component satisfies every guarantee on every
 * one of these renders today, including a table at width 1, an unclosed fence, a NUL byte and a lone
 * surrogate. A render that starts failing lands in a ledger only by someone editing this file, which is
 * where the decision belongs.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Markup interpreted wrongly. A heading rendered as body text, a fence highlighted with the wrong
 * language or a table column misaligned satisfies all nine guarantees. It also does not reach
 * `renderInlineMarkdown`, the second entry point, which returns a single string rather than rows and
 * has no width to fit.
 *
 * It also cannot see a defect that needs a width between the seven the sweep drives, or a source
 * construct no fixture carries.
 *
 * MUTATION GATE, run and recorded:
 * - `widthOf` in the runner replaced by `text.length`: 3 fail.
 * - the table scope dropped from `aWiderTerminalNeverNeedsMoreRows`: 1 fail, naming `wideTable`.
 * - `painted()` returning its rows unfiltered: 1 fail on the prefix guarantee.
 * - the prefix render taking the whole source instead of the prefix: 1 fail.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	MARKDOWN_ORACLE_GUARANTEES,
	type MarkdownEvaluationResult,
	type MarkdownOracleFrameState,
	type MarkdownOracleGuarantee,
	plainRow,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import { evaluateMarkdownCase, type MarkdownCase, markdownCases, markdownStateFor } from "./helpers/defect-oracles";

/** `fixture@width/paddingX`, the pair a ledger row names. */
function label(spec: MarkdownCase): string {
	return `${spec.fixture}@${spec.width}/${spec.paddingX}`;
}

/**
 * The renders that violate a guarantee today, per guarantee, by exact set equality.
 *
 * Empty for all nine. A ledger row is a decision to ship a known defect, so an empty ledger is the
 * claim that there are none on this axis, and a new offender fails rather than being absorbed.
 */
const KNOWN_OFFENDERS: Readonly<Record<MarkdownOracleGuarantee, readonly string[]>> = {
	everyRowFitsTheWidth: [],
	noRowCarriesALineBreak: [],
	noRowForwardsARawTab: [],
	noRowSeversAnEscapeSequence: [],
	theLeftPaddingIsOnEveryPaintedRow: [],
	aSecondInstanceRendersTheSameRows: [],
	aResizedInstanceReturnsToItsFirstRows: [],
	aWiderTerminalNeverNeedsMoreRows: [],
	aFrozenPrefixRendersAsAPrefix: [],
};

/**
 * Why a guarantee may report `blind` on a render: it applied and had nothing to read.
 *
 * A blind verdict looks like a pass to a caller that reads only `failures`, so each one has to be
 * explained by a predicate over the state. A guarantee absent from this table is asserted never blind.
 */
const BLIND_REASONS: Partial<Record<MarkdownOracleGuarantee, (state: MarkdownOracleFrameState) => boolean>> = {
	// An empty source renders no rows, so a row check has nothing to read.
	everyRowFitsTheWidth: state => state.rows.length === 0,
	noRowCarriesALineBreak: state => state.rows.length === 0,
	noRowForwardsARawTab: state => state.rows.length === 0,
	aSecondInstanceRendersTheSameRows: state => state.rows.length === 0,
	aResizedInstanceReturnsToItsFirstRows: state => state.rows.length === 0,
	// A source whose rows carry no styling has no escape sequence to sever.
	noRowSeversAnEscapeSequence: state => state.rows.every(row => !row.includes("\x1b")),
	// A render that paints nothing has no row for the padding to be on.
	theLeftPaddingIsOnEveryPaintedRow: state => state.rows.every(row => plainRow(row).trim() === ""),
	// A prefix that renders nothing has no row to compare against the head of the full render.
	aFrozenPrefixRendersAsAPrefix: state => (state.prefix?.rows ?? []).every(row => plainRow(row).trim() === ""),
	// The next width exists whenever this guarantee applies, but a source that renders nothing has no
	// row count to compare.
	aWiderTerminalNeverNeedsMoreRows: state => state.rows.length === 0,
};

const CASES = markdownCases();

describe("no markdown render corrupts the rows it returns", () => {
	let results: { spec: MarkdownCase; evaluation: MarkdownEvaluationResult }[] = [];

	beforeAll(async () => {
		await initTheme(false);
		results = CASES.map(spec => ({ spec, evaluation: evaluateMarkdownCase(spec) }));
	}, 900_000);

	it("drives every fixture at every width and padding", () => {
		expect(CASES.length).toBeGreaterThan(400);
		expect(new Set(CASES.map(label)).size).toBe(CASES.length);
	});

	it.each(MARKDOWN_ORACLE_GUARANTEES.map(id => [id] as const))("%s holds on exactly its known offenders", id => {
		const offenders = results
			.filter(entry => entry.evaluation.failures.some(failure => failure.oracle === id))
			.map(entry => label(entry.spec));
		const messages = results
			.flatMap(entry => entry.evaluation.failures.filter(failure => failure.oracle === id).map(f => f.message))
			.slice(0, 4);
		expect(offenders.sort(), messages.join("\n")).toEqual([...KNOWN_OFFENDERS[id]].sort());
	});

	it.each(MARKDOWN_ORACLE_GUARANTEES.map(id => [id] as const))("%s reads a subject on some render", id => {
		const inspected = results.filter(entry => entry.evaluation.inspected.includes(id));
		expect(inspected.length).toBeGreaterThan(0);
	});

	it.each(MARKDOWN_ORACLE_GUARANTEES.map(id => [id] as const))("%s is blind only for a stated reason", id => {
		const reason = BLIND_REASONS[id];
		const blind = results.filter(entry => entry.evaluation.blind.includes(id));
		if (!reason) {
			expect(blind.map(entry => label(entry.spec))).toEqual([]);
			return;
		}
		const unexplained = blind.filter(entry => !reason(markdownStateFor(entry.spec))).map(entry => label(entry.spec));
		expect(unexplained).toEqual([]);
	});

	it("reports one verdict per render, never one per sweep", () => {
		expect(results.length).toBe(CASES.length);
		for (const entry of results) {
			const seen = [
				...entry.evaluation.inspected,
				...entry.evaluation.blind,
				...entry.evaluation.skipped,
				...entry.evaluation.failures.map(failure => failure.oracle),
			];
			expect(new Set(seen).size).toBe(MARKDOWN_ORACLE_GUARANTEES.length);
		}
	});
});
