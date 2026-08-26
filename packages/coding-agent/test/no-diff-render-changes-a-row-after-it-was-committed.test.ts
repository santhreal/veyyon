/**
 * WHY THIS SUITE EXISTS:
 * `renderDiff` is the one renderer here with a byte-level obligation rather than a cell-level one. The
 * transcript commits its rows to native scrollback as the diff arrives, and a committed row cannot be
 * repainted, so a row that renders one way while the diff is still streaming and another way once it
 * has finished is a row on screen that no longer matches the render.
 *
 * The renderer states that obligation itself: it reserves three gutter digits instead of deriving the
 * width from the largest line number, and the comment explaining why names the failure exactly. Nothing
 * tested the claim, and the claim is only half true.
 *
 * WHAT IT ASSERTS:
 * Every diff fixture through every file path, against all nine guarantees, with the prefix render of
 * every row compared byte for byte against the head of the finished render. Eight ledgers are pinned
 * empty. The ninth pins the diffs whose streamed prefix does not match, by exact set equality.
 *
 * The live field it pins: a single-line replacement renders its removed row twice. `renderIntraLineDiff`
 * runs `replaceTabs` before `visualizeIndent`, so the paired path sees spaces where the unpaired path
 * saw tabs, and the removed row's leading tabs are painted as arrows while it is the last row of the
 * stream and as middle dots once its `+` partner lands. Tab-indented source is most of this repository.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Whether the diff is right. Which lines a patch touched, whether the word-level split is the readable
 * one, and whether the highlighter picked the right token colours are separate contracts.
 *
 * It also cannot see a row that changes between two renders separated by something other than a longer
 * diff: a theme switch, a settings change or an `.editorconfig` edit mid-stream all repaint rows this
 * suite renders identically, because it holds the theme fixed for the whole sweep.
 *
 * MUTATION GATE, run and recorded:
 * - the reserved gutter floor dropped from 3 to 0: 1 fail, naming the hundred-line crossing.
 * - the line-number dedup removed: 1 fail on the single-line replacement.
 * - `firstDifference` returning -1 unconditionally: 2 fail.
 * - the `everyLineNumberFitsTheReservedGutter` scope forced true: 1 fail, naming the thousand crossing.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	DIFF_RENDER_ORACLE_GUARANTEES,
	type DiffRenderEvaluationResult,
	type DiffRenderOracleFrameState,
	type DiffRenderOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import {
	DIFF_FILE_PATHS,
	type DiffRenderCase,
	diffRenderCases,
	diffStateFor,
	evaluateDiffRenderCase,
	promoteDiffRenderFailureToCorpus,
} from "./helpers/defect-oracles";

/** `fixture@path`, the pair a ledger row names. */
function label(spec: DiffRenderCase): string {
	return `${spec.fixture}@${DIFF_FILE_PATHS[spec.filePath] ?? "no-path"}`;
}

/**
 * The renders that violate a guarantee today, per guarantee, by exact set equality.
 *
 * `aStreamedPrefixRendersByteIdentically` is the one non-empty ledger. Every entry is a diff containing
 * a single-line replacement whose removed row is indented with tabs: the removed row renders with the
 * tab glyph while it is the last row of the stream, and with space glyphs once the `+` row arrives,
 * because the paired path expands tabs before visualising the indent and the unpaired path does not.
 * A diff with the same shape and space indentation is not in the ledger, which is what says the defect
 * is the tab handling rather than the pairing.
 */
const KNOWN_OFFENDERS: Readonly<Record<DiffRenderOracleGuarantee, readonly string[]>> = {
	everyInputRowProducesExactlyOneRow: [],
	noRenderedDiffRowCarriesALineBreak: [],
	noRenderedDiffRowForwardsARawTab: [],
	noRenderedDiffRowSeversAnEscapeSequence: [],
	everyNumberedRowPaintsItsGutterAtTheSameColumn: [],
	noRowRepeatsThePreviousRowsLineNumber: [],
	everyRowKeepsThePrintableContentItWasGiven: [],
	noContentSuppliedEscapeSurvivesIntoARow: [],
	aSecondRenderReturnsTheSameBytes: [],
	aStreamedPrefixRendersByteIdentically: ["tabIndent@no-path", "tabIndent@notes.txt", "tabIndent@src/example.ts"],
};

/**
 * Why a guarantee may report `blind` on a render: it applied and had nothing to read.
 *
 * A blind verdict looks like a pass to a caller that reads only `failures`, so each one is explained by
 * a predicate over the state. A guarantee absent from this table is asserted never blind.
 */
const BLIND_REASONS: Partial<Record<DiffRenderOracleGuarantee, (state: DiffRenderOracleFrameState) => boolean>> = {
	// An empty diff renders one empty row and parses to one row that claims nothing.
	noRenderedDiffRowCarriesALineBreak: state => state.rows.length === 0,
	noRenderedDiffRowForwardsARawTab: state => state.rows.length === 0,
	aSecondRenderReturnsTheSameBytes: state => state.rows.length === 0,
	// A diff whose rows carry no escape bytes has none to sever.
	noRenderedDiffRowSeversAnEscapeSequence: state => state.rows.every(row => !row.includes("\x1b")),
	// A diff of gap rows alone paints no gutter and no line number.
	everyNumberedRowPaintsItsGutterAtTheSameColumn: state =>
		state.inputRows.every(row => row.marker === null || row.lineNumber.trim() === ""),
	noRowRepeatsThePreviousRowsLineNumber: state =>
		state.inputRows.every(row => row.marker === null || row.lineNumber.trim() === ""),
	// A diff whose every row is a gap or carries empty content has no content to keep.
	everyRowKeepsThePrintableContentItWasGiven: state =>
		state.inputRows.every(row => row.marker === null || row.content.replace(/\s/g, "") === ""),
	// The prefix comparison stands down past 999 lines rather than reading nothing, so it is blind only
	// on a diff with no rows at all.
	aStreamedPrefixRendersByteIdentically: state => state.prefixRenders.length === 0,
	// A diff whose content carries no escape byte has none for the sanitizer to strip. The guarantee
	// stands down on those rather than reading nothing, so this covers only a diff that is all escapes.
	noContentSuppliedEscapeSurvivesIntoARow: state => !state.diffText.includes("\x1b"),
};

const CASES = diffRenderCases();

describe("no diff render changes a row after it was committed", () => {
	let results: { spec: DiffRenderCase; evaluation: DiffRenderEvaluationResult }[] = [];

	beforeAll(async () => {
		await initTheme(false);
		results = CASES.map(spec => ({ spec, evaluation: evaluateDiffRenderCase(spec) }));
		// One case per guarantee rather than one per offending render, and only under
		// VEYYON_ORACLE_CORPUS=record. Recording from inside the sweep is what makes the committed rows
		// reproducible: the grid a case carries is styled, and a render taken in a terminal with a
		// different colour depth replays as different bytes.
		const promoted = new Set<DiffRenderOracleGuarantee>();
		for (const entry of results) {
			for (const failure of entry.evaluation.failures) {
				if (promoted.has(failure.oracle)) continue;
				promoted.add(failure.oracle);
				promoteDiffRenderFailureToCorpus(entry.spec, failure, diffStateFor(entry.spec).rows, {
					template: "diff-render-sweep",
				});
			}
		}
	}, 900_000);

	it("drives every fixture through every file path", () => {
		expect(CASES.length).toBe(Object.keys(DIFF_FILE_PATHS).length * (CASES.length / DIFF_FILE_PATHS.length));
		expect(new Set(CASES.map(label)).size).toBe(CASES.length);
		expect(CASES.length).toBeGreaterThan(70);
	});

	it.each(DIFF_RENDER_ORACLE_GUARANTEES.map(id => [id] as const))("%s holds on exactly its known offenders", id => {
		const offenders = results
			.filter(entry => entry.evaluation.failures.some(failure => failure.oracle === id))
			.map(entry => label(entry.spec));
		const messages = results
			.flatMap(entry => entry.evaluation.failures.filter(failure => failure.oracle === id).map(f => f.message))
			.slice(0, 3);
		expect(offenders.sort(), messages.join("\n")).toEqual([...KNOWN_OFFENDERS[id]].sort());
	});

	it("pins the streaming defect to tab indentation, not to the single-line replacement", () => {
		// `spaceIndent` is the same shape with spaces instead of tabs, and `tabIndentBlock` is tab
		// indentation without the one-for-one pairing. Both render byte-identically while streaming, which
		// is what makes the ledger a statement about the tab expansion rather than about pairing.
		for (const fixture of ["spaceIndent", "tabIndentBlock", "identicalReplacement"]) {
			const entries = results.filter(entry => entry.spec.fixture === fixture);
			expect(entries.length).toBe(DIFF_FILE_PATHS.length);
			for (const entry of entries) {
				expect(
					entry.evaluation.failures.map(failure => failure.oracle),
					`${fixture} should stream cleanly`,
				).toEqual([]);
			}
		}
	});

	it.each(DIFF_RENDER_ORACLE_GUARANTEES.map(id => [id] as const))("%s reads a subject on some render", id => {
		expect(results.filter(entry => entry.evaluation.inspected.includes(id)).length).toBeGreaterThan(0);
	});

	it.each(DIFF_RENDER_ORACLE_GUARANTEES.map(id => [id] as const))("%s is blind only for a stated reason", id => {
		const reason = BLIND_REASONS[id];
		const blind = results.filter(entry => entry.evaluation.blind.includes(id));
		if (!reason) {
			expect(blind.map(entry => label(entry.spec))).toEqual([]);
			return;
		}
		const unexplained = blind.filter(entry => !reason(diffStateFor(entry.spec))).map(entry => label(entry.spec));
		expect(unexplained).toEqual([]);
	});

	it("stands the streaming guarantee down past the reserved gutter, and only there", () => {
		const stoodDown = results
			.filter(entry => entry.evaluation.skipped.includes("aStreamedPrefixRendersByteIdentically"))
			.map(entry => entry.spec.fixture);
		expect([...new Set(stoodDown)].sort()).toEqual(["crossingThousand", "pastThousand"]);
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
			expect(new Set(seen).size).toBe(DIFF_RENDER_ORACLE_GUARANTEES.length);
		}
	});
});
