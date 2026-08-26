/**
 * The defect oracles for the diff renderer the edit tools paint every change through.
 *
 * WHY THIS REGISTRY EXISTS:
 * `renderDiff` turns a line-numbered diff into styled rows, and the transcript commits those rows to
 * native scrollback as they arrive. That makes it the one renderer here with a byte-level obligation
 * rather than a cell-level one: a row already committed to scrollback cannot be repainted, so a row
 * that renders one way while the diff is still arriving and another way once it has finished is not a
 * cosmetic difference. It is a row on screen that no longer matches the render.
 *
 * The renderer states that obligation itself. It reserves three gutter digits rather than deriving the
 * width from the largest line number, and the comment explaining why names the exact failure: a width
 * that widens at the hundred-line crossing re-pads every already-rendered row, breaks the transcript's
 * append-only commit detection, and forces a full recommit of the block. Nothing tested the claim.
 *
 * WHAT A STATE IS:
 * One diff text and its render, plus the renders it has to agree with: the same text rendered again,
 * and the render of every prefix of its rows. A guarantee that needs a comparison reads it from the
 * state rather than rendering again, so an oracle never drives the renderer it is judging.
 *
 * WHAT IS NOT JUDGED HERE:
 * Whether the diff is correct. Which lines a patch touched, whether the intra-line word diff picked the
 * best split, and whether the syntax highlighter chose the right token colours are decisions with their
 * own tests. These oracles read what every rendered row has to satisfy whatever the diff said.
 */

import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const DIFF_RENDER_ORACLE_GUARANTEES = [
	"everyInputRowProducesExactlyOneRow",
	"noRenderedDiffRowCarriesALineBreak",
	"noRenderedDiffRowForwardsARawTab",
	"noRenderedDiffRowSeversAnEscapeSequence",
	"everyNumberedRowPaintsItsGutterAtTheSameColumn",
	"noRowRepeatsThePreviousRowsLineNumber",
	"everyRowKeepsThePrintableContentItWasGiven",
	"noContentSuppliedEscapeSurvivesIntoARow",
	"aSecondRenderReturnsTheSameBytes",
	"aStreamedPrefixRendersByteIdentically",
] as const;

export type DiffRenderOracleGuarantee = (typeof DIFF_RENDER_ORACLE_GUARANTEES)[number];

/** One diff row as the renderer's own parser reads it. */
export interface DiffInputRow {
	/** The raw input line. */
	raw: string;
	/** `-`, `+` or a space for a numbered row; `null` for a gap row the parser does not claim. */
	marker: "-" | "+" | " " | null;
	/** The line number as written, empty when the row carries none. */
	lineNumber: string;
	/** The content after the separator, empty for a gap row. */
	content: string;
}

/** One render, and the renders it has to agree with. */
export interface DiffRenderOracleFrameState {
	/** The name of the diff fixture, for a failure that names the case. */
	fixture: string;
	/** The diff as it was handed to the renderer. */
	diffText: string;
	/**
	 * The diff after the renderer's own sanitization pass, which is what it actually parses and paints.
	 *
	 * A content comparison reads this rather than `diffText`: a diff carries whatever a file held,
	 * including escape bytes, and the renderer strips those before it ever splits the text into rows.
	 * Comparing a row against the unsanitized content would report the stripping as lost content.
	 */
	sanitizedDiffText: string;
	/** The input rows, parsed the way the renderer parses them, from the sanitized text. */
	inputRows: readonly DiffInputRow[];
	/** The rendered rows. */
	rows: readonly string[];
	/** The same text rendered a second time. */
	rowsFromASecondRender: readonly string[];
	/**
	 * The render of each proper prefix of the input rows, indexed by prefix length minus one, which is
	 * what the transcript paints while a diff is still arriving.
	 */
	prefixRenders: readonly (readonly string[])[];
	/**
	 * Whether every line number in the diff fits the three digits the renderer reserves.
	 *
	 * The reservation is what makes a streamed prefix byte-identical to the head of the finished render.
	 * Past 999 the gutter widens and every earlier row re-pads, which the renderer documents as the
	 * bound of the guarantee rather than as a case it handles.
	 */
	everyLineNumberFitsTheReservedGutter: boolean;
	/** The product's own width function, so an oracle measures a row the way the product does. */
	widthOf: (text: string) => number;
}

export interface DiffRenderOracleFailure {
	oracle: DiffRenderOracleGuarantee;
	message: string;
}

export type DiffRenderEvaluationResult = DefectEvaluation<DiffRenderOracleGuarantee, DiffRenderOracleFailure>;

const CSI = /^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/;
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const SHORT_ESCAPE = /^\x1b(?![[\]])[ -/]*[0-~]/;

/** Strip every complete escape sequence, leaving the cells a row paints. */
export function plainDiffRow(row: string): string {
	let out = "";
	for (let index = 0; index < row.length; ) {
		if (row[index] === "\x1b") {
			const rest = row.slice(index);
			const match = CSI.exec(rest) ?? OSC.exec(rest) ?? SHORT_ESCAPE.exec(rest);
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		out += row[index];
		index += 1;
	}
	return out;
}

function severedEscapeAt(row: string): number {
	for (let index = 0; index < row.length; index++) {
		if (row[index] !== "\x1b") continue;
		const rest = row.slice(index);
		if (CSI.test(rest) || OSC.test(rest) || SHORT_ESCAPE.test(rest)) continue;
		return index;
	}
	return -1;
}

/** The gutter separator the renderer paints between the line number and the content. */
const GUTTER = "│";

/**
 * The glyphs the indent visualiser substitutes for leading whitespace, plus whitespace itself.
 *
 * A content comparison ignores them: a tab painted as an arrow and a space painted as a middle dot are
 * the same content rendered, and which one a row shows is the visualiser's decision, not the content's.
 */
const LAYOUT_GLYPHS = /[\s·→]/g;
/** Control bytes `sanitizeText` strips before the renderer ever sees them. */
const STRIPPED_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function firstDifference(left: readonly string[], right: readonly string[]): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index++) {
		if (left[index] !== right[index]) return index;
	}
	return left.length === right.length ? -1 : shared;
}

/** The column the gutter separator sits at, or -1 on a row that paints none. */
function gutterColumn(row: string): number {
	return plainDiffRow(row).indexOf(GUTTER);
}

/** The line number a rendered row paints in its gutter, or the empty string. */
function paintedLineNumber(row: string): string {
	return /^\s*[+\-\s]?\s*(\d+)│/.exec(plainDiffRow(row))?.[1] ?? "";
}

function label(state: DiffRenderOracleFrameState): string {
	return state.fixture;
}

interface DiffRenderOracle {
	guarantee: string;
	appliesTo: (state: DiffRenderOracleFrameState) => boolean;
	subject: string;
	subjectSize: (state: DiffRenderOracleFrameState) => number;
	check: (state: DiffRenderOracleFrameState) => DiffRenderOracleFailure | null;
}

const always = (): boolean => true;
const rowCount = (state: DiffRenderOracleFrameState): number => state.rows.length;

export const DIFF_RENDER_ORACLES: Readonly<Record<DiffRenderOracleGuarantee, DiffRenderOracle>> = {
	everyInputRowProducesExactlyOneRow: {
		guarantee:
			"A diff renders one row per input row. The transcript commits rows to native scrollback by position, so a renderer that merges two rows or emits a spare shifts every row after it.",
		appliesTo: always,
		subject: "the input rows against the rendered rows",
		subjectSize: state => state.inputRows.length,
		check: state => {
			if (state.rows.length === state.inputRows.length) return null;
			return {
				oracle: "everyInputRowProducesExactlyOneRow",
				message: `${label(state)}: ${state.inputRows.length} input rows rendered as ${state.rows.length}.`,
			};
		},
	},
	noRenderedDiffRowCarriesALineBreak: {
		guarantee: "A rendered row is one line. A break inside one moves the cursor and shifts the rows after it.",
		appliesTo: always,
		subject: "the rendered rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!/[\n\r]/.test(row)) continue;
				return {
					oracle: "noRenderedDiffRowCarriesALineBreak",
					message: `${label(state)}: row ${index} carries a line break: ${JSON.stringify(row.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noRenderedDiffRowForwardsARawTab: {
		guarantee:
			"A tab jumps to the next stop, past the gutter the renderer reserved. A diff expands or visualises its own.",
		appliesTo: always,
		subject: "the rendered rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!row.includes("\t")) continue;
				return {
					oracle: "noRenderedDiffRowForwardsARawTab",
					message: `${label(state)}: row ${index} forwards a raw tab: ${JSON.stringify(row.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noRenderedDiffRowSeversAnEscapeSequence: {
		guarantee:
			"Every ESC in a row begins a complete sequence. A diff carries escape bytes in its own content, so a row that forwards one unterminated leaves the terminal mid-style for everything painted after it.",
		appliesTo: always,
		subject: "the rows that carry an escape sequence",
		subjectSize: state => state.rows.filter(row => row.includes("\x1b")).length,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const at = severedEscapeAt(row);
				if (at === -1) continue;
				return {
					oracle: "noRenderedDiffRowSeversAnEscapeSequence",
					message: `${label(state)}: row ${index} carries an ESC at ${at} that begins no complete sequence.`,
				};
			}
			return null;
		},
	},
	everyNumberedRowPaintsItsGutterAtTheSameColumn: {
		guarantee:
			"Every numbered row in one render puts its gutter separator at the same column. A gutter that moves between rows misaligns the code the reader is comparing.",
		appliesTo: always,
		subject: "the rows that paint a gutter",
		subjectSize: state => state.rows.filter(row => gutterColumn(row) !== -1).length,
		check: state => {
			const columns = new Map<number, number>();
			for (const [index, row] of state.rows.entries()) {
				const column = gutterColumn(row);
				if (column === -1) continue;
				if (!columns.has(column)) columns.set(column, index);
			}
			if (columns.size <= 1) return null;
			const seen = [...columns.entries()].map(([column, index]) => `${column} at row ${index}`);
			return {
				oracle: "everyNumberedRowPaintsItsGutterAtTheSameColumn",
				message: `${label(state)}: the gutter sits at ${seen.join(", ")}.`,
			};
		},
	},
	noRowRepeatsThePreviousRowsLineNumber: {
		guarantee:
			"A line number is painted once. A single-line replacement names the same line twice, and repeating the number in both gutters reads as two separate lines.",
		appliesTo: always,
		subject: "the rows that paint a line number",
		subjectSize: state => state.rows.filter(row => paintedLineNumber(row) !== "").length,
		check: state => {
			let previous = "";
			for (const [index, row] of state.rows.entries()) {
				const number = paintedLineNumber(row);
				if (number !== "" && number === previous) {
					return {
						oracle: "noRowRepeatsThePreviousRowsLineNumber",
						message: `${label(state)}: row ${index} repeats line number ${number}.`,
					};
				}
				previous = number;
			}
			return null;
		},
	},
	noContentSuppliedEscapeSurvivesIntoARow: {
		guarantee:
			"An escape sequence in the diff's own content never reaches a cell. A file under review can hold any bytes, and a surviving SGR sequence restyles every row painted after it, including rows the diff does not own. The renderer's sanitization pass is what has to remove them, so a row's escapes are all the renderer's own styling.",
		appliesTo: state => state.diffText.includes("\x1b"),
		subject: "the escape sequences the diff content carried",
		subjectSize: state => (state.diffText.includes("\x1b") ? 1 : 0),
		check: state => {
			if (!state.sanitizedDiffText.includes("\x1b")) return null;
			const at = state.sanitizedDiffText.indexOf("\x1b");
			return {
				oracle: "noContentSuppliedEscapeSurvivesIntoARow",
				message: `${label(state)}: an ESC from the diff content survived sanitization at offset ${at}: ${JSON.stringify(state.sanitizedDiffText.slice(at, at + 24))}`,
			};
		},
	},
	everyRowKeepsThePrintableContentItWasGiven: {
		guarantee:
			"A rendered row still paints the printable glyphs of the content it was given. Styling, word-level inverse and syntax highlighting are attributes of a cell; dropping a glyph is a wrong diff on screen.",
		appliesTo: always,
		subject: "the input rows that carry content",
		subjectSize: state => state.inputRows.filter(row => row.marker !== null && row.content !== "").length,
		check: state => {
			for (const [index, input] of state.inputRows.entries()) {
				if (input.marker === null || input.content === "") continue;
				const wanted = input.content.replace(STRIPPED_CONTROLS, "").replace(LAYOUT_GLYPHS, "");
				if (wanted === "") continue;
				const painted = plainDiffRow(state.rows[index] ?? "").replace(LAYOUT_GLYPHS, "");
				if (painted.includes(wanted)) continue;
				return {
					oracle: "everyRowKeepsThePrintableContentItWasGiven",
					message: `${label(state)}: row ${index} lost content. Wanted ${JSON.stringify(wanted.slice(0, 50))} inside ${JSON.stringify(painted.slice(0, 70))}`,
				};
			}
			return null;
		},
	},
	aSecondRenderReturnsTheSameBytes: {
		guarantee:
			"Rendering the same diff twice returns the same bytes. The renderer reads a theme and a highlighter cache, so a second render that differs means the first one is not reproducible from the diff alone.",
		appliesTo: always,
		subject: "this render and a second one",
		subjectSize: rowCount,
		check: state => {
			const at = firstDifference(state.rows, state.rowsFromASecondRender);
			if (at === -1) return null;
			return {
				oracle: "aSecondRenderReturnsTheSameBytes",
				message: `${label(state)}: a second render differs from row ${at} (${state.rows.length} rows against ${state.rowsFromASecondRender.length}).`,
			};
		},
	},
	aStreamedPrefixRendersByteIdentically: {
		guarantee:
			"The render of the first N rows of a diff is byte-identical to the first N rows of the whole diff's render. The transcript commits a streamed row to native scrollback as it arrives, so a row that renders differently once the rest of the diff has landed is a row on screen that no longer matches the render, and it forces a full recommit of the block. The renderer reserves three gutter digits for exactly this reason, which is also the bound: past 999 lines the gutter widens and every earlier row re-pads.",
		appliesTo: state => state.everyLineNumberFitsTheReservedGutter && state.prefixRenders.length > 0,
		subject: "each prefix render against the head of the full render",
		subjectSize: state => (state.everyLineNumberFitsTheReservedGutter ? state.prefixRenders.length : 0),
		check: state => {
			for (const [index, prefix] of state.prefixRenders.entries()) {
				const length = index + 1;
				const head = state.rows.slice(0, length);
				const at = firstDifference(prefix, head);
				if (at === -1) continue;
				return {
					oracle: "aStreamedPrefixRendersByteIdentically",
					message: `${label(state)}: streaming ${length} of ${state.rows.length} rows renders row ${at} as ${JSON.stringify(plainDiffRow(prefix[at] ?? "").slice(0, 60))}, the finished diff renders it as ${JSON.stringify(plainDiffRow(head[at] ?? "").slice(0, 60))}`,
				};
			}
			return null;
		},
	},
};

const PROBE: OracleProbe<DiffRenderOracleGuarantee, DiffRenderOracleFrameState, DiffRenderOracleFailure> = {
	appliesTo: (id, state) => DIFF_RENDER_ORACLES[id].appliesTo(state),
	subjectSize: (id, state) => DIFF_RENDER_ORACLES[id].subjectSize(state),
	check: (id, state) => DIFF_RENDER_ORACLES[id].check(state),
};

/** Judge one diff render against every guarantee in the registry. */
export function evaluateAllDiffRenderOracles(state: DiffRenderOracleFrameState): DiffRenderEvaluationResult {
	return evaluateOracleRegistry(DIFF_RENDER_ORACLE_GUARANTEES, state, PROBE);
}
