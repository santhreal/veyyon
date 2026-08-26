/**
 * The defect oracles for the markdown component every transcript row comes out of.
 *
 * WHY THIS REGISTRY EXISTS:
 * Thirty-four call sites construct a `Markdown` and paint what it returns: assistant messages,
 * thinking traces, tool bodies, dialogs, overlays, plan reviews, the commit agent. The composer and
 * overlay registries judge the grid those rows land in, and the tool-render registry judges the rows a
 * tool renderer builds by hand, but nothing judged the component that produces most of the rows in a
 * session.
 *
 * It is also the component with the most caching. It holds a render cache keyed by text and width, an
 * LRU shared between instances, and a streaming-lex cache that freezes the largest blank-line-bounded
 * prefix of the text and re-lexes only the tail. Each of those is a place where a correct renderer
 * returns the wrong rows, and none of it is visible in a single render of a single string: it takes a
 * second instance, a resize, or a prefix of the same text to see.
 *
 * WHAT A STATE IS:
 * One render of one source at one width, plus the renders it has to agree with: the same text through
 * a second instance, the same instance after a resize and back, the next wider width, and the largest
 * blank-line-bounded prefix of the source. A guarantee that needs a comparison reads it from the state
 * rather than rendering again, so an oracle never drives the component it is judging.
 *
 * WHAT IS NOT JUDGED HERE:
 * Whether the markup was interpreted correctly. Whether a heading is bold, a fence is highlighted or a
 * table is aligned the way the theme intends is a rendering decision with its own tests; these oracles
 * read what every row has to satisfy whatever the markup meant.
 */

import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const MARKDOWN_ORACLE_GUARANTEES = [
	"everyRowFitsTheWidth",
	"noRowCarriesALineBreak",
	"noRowForwardsARawTab",
	"noRowSeversAnEscapeSequence",
	"theLeftPaddingIsOnEveryPaintedRow",
	"aSecondInstanceRendersTheSameRows",
	"aResizedInstanceReturnsToItsFirstRows",
	"aWiderTerminalNeverNeedsMoreRows",
	"aFrozenPrefixRendersAsAPrefix",
] as const;

export type MarkdownOracleGuarantee = (typeof MARKDOWN_ORACLE_GUARANTEES)[number];

/** One render, and the renders it has to agree with. */
export interface MarkdownOracleFrameState {
	/** The name of the source fixture, for a failure that names the case. */
	fixture: string;
	source: string;
	width: number;
	paddingX: number;
	rows: readonly string[];
	/** The same text and width through a second instance, which shares the process-wide LRU. */
	rowsFromASecondInstance: readonly string[];
	/** The same instance rendered at another width and then back to this one. */
	rowsAfterAResize: readonly string[];
	/** The rows at the next wider width the sweep drives, or `null` at the widest. */
	rowsAtTheNextWidth: readonly string[] | null;
	/**
	 * The largest blank-line-bounded prefix of the source and its own render, or `null` when the source
	 * has no blank line. This is the streaming path: the component freezes such a prefix and re-lexes
	 * only the tail.
	 */
	prefix: { text: string; rows: readonly string[] } | null;
	/**
	 * Whether the source contains a table.
	 *
	 * A table is the one construct whose row count grows with the width: a wider terminal fits more
	 * columns, and each column's cell wraps into its own rows. Recorded on the state so the width
	 * monotonicity guarantee declares those sources out of scope rather than reporting them.
	 */
	sourceHasATable: boolean;
	/** The product's own width function, so an oracle measures a row the way the product does. */
	widthOf: (text: string) => number;
}

export interface MarkdownOracleFailure {
	oracle: MarkdownOracleGuarantee;
	message: string;
}

export type MarkdownEvaluationResult = DefectEvaluation<MarkdownOracleGuarantee, MarkdownOracleFailure>;

const CSI = /^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/;
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const SHORT_ESCAPE = /^\x1b(?![[\]])[ -/]*[0-~]/;

/** Strip every complete escape sequence, leaving the cells a row paints. */
export function plainRow(row: string): string {
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

/** The rows a comparison reads, with the blank rows a prefix render pads with dropped. */
function painted(rows: readonly string[]): readonly string[] {
	return rows.filter(row => plainRow(row).trim() !== "");
}

function firstDifference(left: readonly string[], right: readonly string[]): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index++) {
		if (left[index] !== right[index]) return index;
	}
	return left.length === right.length ? -1 : shared;
}
/**
 * How many grapheme clusters a string paints.
 *
 * A single cluster wider than the column it was given cannot be broken by any wrap: the renderer's
 * only alternatives are painting it over budget or dropping it, so an over-width row of one cluster is
 * not a wrap defect. Two or more clusters is, because a break point existed.
 */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeCount(text: string): number {
	let count = 0;
	for (const _ of SEGMENTER.segment(text)) count += 1;
	return count;
}

function label(state: MarkdownOracleFrameState): string {
	return `${state.fixture} at width ${state.width}`;
}

interface MarkdownOracle {
	guarantee: string;
	appliesTo: (state: MarkdownOracleFrameState) => boolean;
	subject: string;
	subjectSize: (state: MarkdownOracleFrameState) => number;
	check: (state: MarkdownOracleFrameState) => MarkdownOracleFailure | null;
}

const always = (): boolean => true;
const rowCount = (state: MarkdownOracleFrameState): number => state.rows.length;

export const MARKDOWN_ORACLES: Readonly<Record<MarkdownOracleGuarantee, MarkdownOracle>> = {
	everyRowFitsTheWidth: {
		guarantee:
			"A rendered row fits the width it was rendered for. Markdown wraps; it never overflows. Two cases are not overflow: a caller that asks for more padding than the width holds has asked for something no renderer can satisfy, and a single grapheme cluster wider than the content column cannot be broken by any wrap, only dropped.",
		appliesTo: state => state.width > 2 * state.paddingX,
		subject: "the rendered rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const width = state.widthOf(row);
				if (width <= state.width) continue;
				const content = plainRow(row).trim();
				if (graphemeCount(content) <= 1) continue;
				return {
					oracle: "everyRowFitsTheWidth",
					message: `${label(state)}: row ${index} is ${width} cells wide and ${graphemeCount(content)} clusters: ${JSON.stringify(content.slice(0, 80))}`,
				};
			}
			return null;
		},
	},
	noRowCarriesALineBreak: {
		guarantee: "A rendered row is one line. A break inside one moves the cursor and corrupts the frame.",
		appliesTo: always,
		subject: "the rendered rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!/[\n\r]/.test(row)) continue;
				return {
					oracle: "noRowCarriesALineBreak",
					message: `${label(state)}: row ${index} carries a line break: ${JSON.stringify(row.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noRowForwardsARawTab: {
		guarantee: "A tab jumps to the next stop, past the columns the layout allotted. Markdown expands its own.",
		appliesTo: always,
		subject: "the rendered rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!row.includes("\t")) continue;
				return {
					oracle: "noRowForwardsARawTab",
					message: `${label(state)}: row ${index} forwards a raw tab: ${JSON.stringify(row.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noRowSeversAnEscapeSequence: {
		guarantee: "Every ESC in a row begins a complete sequence. A severed one leaves the terminal mid-style.",
		appliesTo: always,
		subject: "the rows that carry an escape sequence",
		subjectSize: state => state.rows.filter(row => row.includes("\x1b")).length,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const at = severedEscapeAt(row);
				if (at === -1) continue;
				return {
					oracle: "noRowSeversAnEscapeSequence",
					message: `${label(state)}: row ${index} carries an ESC at ${at} that begins no complete sequence.`,
				};
			}
			return null;
		},
	},
	theLeftPaddingIsOnEveryPaintedRow: {
		guarantee:
			"A component asked for horizontal padding indents every row that paints something. A row that skips it lands in the gutter its caller reserved.",
		appliesTo: state => state.paddingX > 0,
		subject: "the rows that paint something",
		subjectSize: state => painted(state.rows).length,
		check: state => {
			const indent = " ".repeat(state.paddingX);
			for (const [index, row] of state.rows.entries()) {
				const plain = plainRow(row);
				if (plain.trim() === "" || plain.startsWith(indent)) continue;
				return {
					oracle: "theLeftPaddingIsOnEveryPaintedRow",
					message: `${label(state)}: row ${index} starts before the ${state.paddingX}-column padding: ${JSON.stringify(plain.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	aSecondInstanceRendersTheSameRows: {
		guarantee:
			"The same text at the same width renders the same rows, whichever instance renders it. The render cache is shared between instances, so a key that misses a field hands one instance another's rows.",
		appliesTo: always,
		subject: "this render and a second instance's",
		subjectSize: rowCount,
		check: state => {
			const at = firstDifference(state.rows, state.rowsFromASecondInstance);
			if (at === -1) return null;
			return {
				oracle: "aSecondInstanceRendersTheSameRows",
				message: `${label(state)}: a second instance differs from row ${at} (${state.rows.length} rows against ${state.rowsFromASecondInstance.length}).`,
			};
		},
	},
	aResizedInstanceReturnsToItsFirstRows: {
		guarantee:
			"An instance rendered at another width and back returns what it returned the first time. A cache keyed on text alone serves the other width's rows.",
		appliesTo: always,
		subject: "this render and the same instance's after a resize",
		subjectSize: rowCount,
		check: state => {
			const at = firstDifference(state.rows, state.rowsAfterAResize);
			if (at === -1) return null;
			return {
				oracle: "aResizedInstanceReturnsToItsFirstRows",
				message: `${label(state)}: after a resize and back the render differs from row ${at} (${state.rows.length} rows against ${state.rowsAfterAResize.length}).`,
			};
		},
	},
	aWiderTerminalNeverNeedsMoreRows: {
		guarantee:
			"Widening the terminal fits more text on a row, so it never takes more rows. A table is the exception, since a wider terminal shows more columns and each cell wraps into rows of its own.",
		appliesTo: state => !state.sourceHasATable && state.rowsAtTheNextWidth !== null,
		subject: "the row counts at this width and the next",
		subjectSize: state => (state.rowsAtTheNextWidth === null ? 0 : 2),
		check: state => {
			const wider = state.rowsAtTheNextWidth;
			if (!wider || wider.length <= state.rows.length) return null;
			return {
				oracle: "aWiderTerminalNeverNeedsMoreRows",
				message: `${label(state)}: ${state.rows.length} rows here, ${wider.length} at the wider width.`,
			};
		},
	},
	aFrozenPrefixRendersAsAPrefix: {
		guarantee:
			"The rows of a blank-line-bounded prefix are the first rows of the whole text's render. This is what the streaming-lex cache assumes when it freezes a prefix and re-lexes only the tail; a prefix whose rows change when the tail arrives means the frozen rows on screen were wrong.",
		appliesTo: state => state.prefix !== null,
		subject: "the prefix's painted rows and the head of the full render",
		subjectSize: state => (state.prefix === null ? 0 : painted(state.prefix.rows).length),
		check: state => {
			if (!state.prefix) return null;
			const prefixRows = painted(state.prefix.rows);
			// Both sides drop the blank rows, because a prefix render pads its own tail and a full render
			// puts the blank line between the prefix and the tail at a different index. Comparing the
			// painted rows is what the streaming cache actually promises: the styled text the user has
			// already seen does not change when the tail arrives.
			const head = painted(state.rows).slice(0, prefixRows.length);
			const at = firstDifference(prefixRows, head);
			if (at === -1) return null;
			return {
				oracle: "aFrozenPrefixRendersAsAPrefix",
				message: `${label(state)}: the frozen prefix differs from the full render at row ${at}: ${JSON.stringify(plainRow(prefixRows[at] ?? "").slice(0, 60))} against ${JSON.stringify(plainRow(head[at] ?? "").slice(0, 60))}`,
			};
		},
	},
};

const PROBE: OracleProbe<MarkdownOracleGuarantee, MarkdownOracleFrameState, MarkdownOracleFailure> = {
	appliesTo: (id, state) => MARKDOWN_ORACLES[id].appliesTo(state),
	subjectSize: (id, state) => MARKDOWN_ORACLES[id].subjectSize(state),
	check: (id, state) => MARKDOWN_ORACLES[id].check(state),
};

/** Judge one markdown render against every guarantee in the registry. */
export function evaluateAllMarkdownOracles(state: MarkdownOracleFrameState): MarkdownEvaluationResult {
	return evaluateOracleRegistry(MARKDOWN_ORACLE_GUARANTEES, state, PROBE);
}
