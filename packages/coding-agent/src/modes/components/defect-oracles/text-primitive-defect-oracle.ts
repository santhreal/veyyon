/**
 * The defect oracles for the text primitives every renderer is required to sanitize through.
 *
 * WHY THIS REGISTRY EXISTS:
 * The composer, overlay and tool-render registries judge rows. All three read the output of the same
 * four functions: a truncation, a wrap, a slice and a width measurement. A defect in one of those is
 * not a defect of one surface, it is a defect of every row the product paints, and none of the three
 * registries can attribute it: they see a corrupted row and blame the renderer that forwarded it.
 *
 * The primitives are also where a defect hides longest, because their contract is stated in cells and
 * their inputs arrive in code units. A width function that counts an escape byte overflows every
 * layout that trusts it; a truncation that cuts an escape in half leaves the terminal in whatever
 * style the severed sequence half-set; a wrap that drops a glyph loses content with no error anywhere.
 *
 * WHAT A STATE IS:
 * One application of one primitive: which primitive, the input, the width or length it was asked for,
 * the options it was given, and the rows it produced. A guarantee that says nothing about a primitive
 * declares that state out of scope rather than passing on it.
 *
 * WHAT IS NOT JUDGED HERE:
 * Whether a primitive agrees with a particular terminal emulator's own width table. The oracles read
 * the product's own measurement, so a disagreement between `visibleWidth` and Ghostty is a defect the
 * grid oracles see and this registry cannot.
 */

import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const TEXT_PRIMITIVE_ORACLE_GUARANTEES = [
	"truncationFitsTheWidth",
	"paddingReachesExactlyTheWidth",
	"truncationKeepsAPrefixOfTheInput",
	"truncationIsIdempotent",
	"everyWrappedRowFitsTheWidth",
	"wrappingKeepsEveryVisibleGlyph",
	"slicingStaysWithinTheLengthAsked",
	"noProducedRowCarriesALineBreak",
	"noProducedRowForwardsARawTab",
	"noEscapeSequenceIsCutInHalf",
	"styleBytesCostNoCells",
	"tabExpansionLeavesNoTab",
	"theHomeDirectoryIsNeverPainted",
] as const;

export type TextPrimitiveOracleGuarantee = (typeof TEXT_PRIMITIVE_ORACLE_GUARANTEES)[number];

/** The primitives this registry judges. One application of one of them is a state. */
export const TEXT_PRIMITIVES = ["truncate", "wrap", "slice", "measure", "expandTabs", "shortenPath"] as const;

export type TextPrimitive = (typeof TEXT_PRIMITIVES)[number];

/** One application of one primitive, and what it produced. */
export interface TextPrimitiveOracleFrameState {
	primitive: TextPrimitive;
	/** The name of the fixture the input came from, for a failure message that names the case. */
	fixture: string;
	input: string;
	/** The width or length asked for. `-1` for a primitive that takes none. */
	width: number;
	/** Whether the truncation was asked to pad the result out to the width. */
	pad: boolean;
	/** Whether a slice was asked to drop a grapheme straddling an edge rather than keep it whole. */
	strict: boolean;
	/** The column a slice started at. */
	startColumn: number;
	/** What the primitive produced. One row for every primitive but `wrap`. */
	rows: readonly string[];
	/** What the product's own width function said about the input, for the `measure` primitive. */
	measuredWidth: number;
	/** The same input with every escape sequence removed, measured by the same function. */
	measuredPlainWidth: number;
	/** The home directory a `shortenPath` application was given. */
	homeDir: string;
	/** The product's own width function, so an oracle measures a row the way the product does. */
	widthOf: (text: string) => number;
	/**
	 * The result of applying the same truncation to its own output.
	 *
	 * Supplied by the caller rather than recomputed here, because an oracle that calls the primitive
	 * it is judging agrees with it when it is wrong.
	 */
	reappliedRow: string;
}

export interface TextPrimitiveOracleFailure {
	oracle: TextPrimitiveOracleGuarantee;
	message: string;
}

export type TextPrimitiveEvaluationResult = DefectEvaluation<TextPrimitiveOracleGuarantee, TextPrimitiveOracleFailure>;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const CSI = /^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/;
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
// A two-byte escape: ESC followed by one final byte. `[` and `]` are excluded because they introduce
// CSI and OSC, whose own patterns are the complete forms; without the exclusion a severed `ESC [ 1 ; 3`
// reads as a complete `ESC [` and the severed-sequence check can never fire.
const SHORT_ESCAPE = /^\x1b(?![[\]])[ -/]*[0-~]/;

/** Strip every complete escape sequence, so what is left is the cells a row paints. */
export function plainText(text: string): string {
	let out = "";
	for (let index = 0; index < text.length; ) {
		if (text[index] === "\x1b") {
			const rest = text.slice(index);
			const match = CSI.exec(rest) ?? OSC.exec(rest) ?? SHORT_ESCAPE.exec(rest);
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		out += text[index];
		index += 1;
	}
	return out;
}

/** The visible characters of a row, ignoring whitespace, in order. */
function glyphsOf(text: string): string {
	let out = "";
	for (const char of plainText(text)) {
		if (!/\s/.test(char)) out += char;
	}
	return out;
}

function graphemeCount(text: string): number {
	let count = 0;
	for (const _ of GRAPHEMES.segment(text)) count += 1;
	return count;
}

/** The first ESC in the row that does not begin a complete sequence, or `-1`. */
function severedEscapeAt(text: string): number {
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\x1b") continue;
		const rest = text.slice(index);
		if (CSI.test(rest) || OSC.test(rest) || SHORT_ESCAPE.test(rest)) continue;
		return index;
	}
	return -1;
}

const PRODUCES_ROWS: readonly TextPrimitive[] = ["truncate", "wrap", "slice", "expandTabs", "shortenPath"];

interface TextPrimitiveOracle {
	guarantee: string;
	/** Which primitives the guarantee says anything about. */
	primitives: readonly TextPrimitive[];
	/** A further condition for the guarantee to mean anything, beyond which primitive ran. */
	appliesTo?: (state: TextPrimitiveOracleFrameState) => boolean;
	subject: string;
	subjectSize: (state: TextPrimitiveOracleFrameState) => number;
	check: (state: TextPrimitiveOracleFrameState) => TextPrimitiveOracleFailure | null;
}

function rowCount(state: TextPrimitiveOracleFrameState): number {
	return state.rows.length;
}

function label(state: TextPrimitiveOracleFrameState): string {
	return `${state.primitive} of ${state.fixture} at width ${state.width}`;
}

export const TEXT_PRIMITIVE_ORACLES: Readonly<Record<TextPrimitiveOracleGuarantee, TextPrimitiveOracle>> = {
	truncationFitsTheWidth: {
		guarantee: "A truncation to a width paints no more cells than that width.",
		primitives: ["truncate"],
		subject: "the truncated row",
		subjectSize: rowCount,
		check: state => {
			const row = state.rows[0] ?? "";
			const width = state.widthOf(row);
			if (width <= state.width) return null;
			return {
				oracle: "truncationFitsTheWidth",
				message: `${label(state)}: the result is ${width} cells wide, past the ${state.width} asked for: ${JSON.stringify(row)}`,
			};
		},
	},
	paddingReachesExactlyTheWidth: {
		guarantee: "A truncation asked to pad returns exactly the width, so a caller can lay out by it.",
		primitives: ["truncate"],
		subject: "the padded row",
		subjectSize: state => (state.pad ? rowCount(state) : 0),
		check: state => {
			const row = state.rows[0] ?? "";
			const width = state.widthOf(row);
			if (width === state.width) return null;
			return {
				oracle: "paddingReachesExactlyTheWidth",
				message: `${label(state)}: padded to ${width} cells rather than exactly ${state.width}: ${JSON.stringify(row)}`,
			};
		},
	},
	truncationKeepsAPrefixOfTheInput: {
		guarantee: "A truncation drops the tail. The glyphs it keeps are a prefix of the input's glyphs.",
		primitives: ["truncate"],
		subject: "the glyphs of the truncated row",
		subjectSize: state => glyphsOf(state.rows[0] ?? "").length,
		check: state => {
			const row = state.rows[0] ?? "";
			const kept = glyphsOf(row);
			// The ellipsis is the one glyph the result may add, at the end, and a width too narrow for
			// the whole marker leaves part of it: at width one the ASCII marker is a single dot. Trailing
			// dots the input ended with are dropped from the result side only, which weakens nothing:
			// the input's own copy of them is still there to match against.
			const withoutEllipsis = kept.replace(/[.…]+$/, "");
			if (glyphsOf(state.input).startsWith(withoutEllipsis)) return null;
			return {
				oracle: "truncationKeepsAPrefixOfTheInput",
				message: `${label(state)}: the result's glyphs are not a prefix of the input's. Kept ${JSON.stringify(withoutEllipsis)}.`,
			};
		},
	},
	truncationIsIdempotent: {
		guarantee: "Truncating an already truncated row to the same width returns it unchanged.",
		primitives: ["truncate"],
		// A raw line break is not a row. `truncateToWidth` is a row operation, and a caller passing it
		// several lines gets a result whose width is measured across the break; re-truncating that is a
		// different question and out of the contract.
		subjectSize: state => (/[\n\r]/.test(state.input) ? 0 : rowCount(state)),
		subject: "the truncated row and the same truncation applied to it",
		check: state => {
			const row = state.rows[0] ?? "";
			if (state.reappliedRow === row) return null;
			return {
				oracle: "truncationIsIdempotent",
				message: `${label(state)}: re-truncating the result changed it, from ${JSON.stringify(row)} to ${JSON.stringify(state.reappliedRow)}.`,
			};
		},
	},
	everyWrappedRowFitsTheWidth: {
		guarantee:
			"A wrapped row fits the width, unless it is one grapheme cluster that cannot: a single wide glyph at width one has to overflow or vanish, and overflowing is the choice that keeps the content.",
		primitives: ["wrap"],
		// A wrap into no columns has no correct answer, and every row it returns overflows by
		// definition. A layout that asks for zero columns is the caller's defect, and the grid oracles
		// are what see it.
		appliesTo: state => state.width >= 1,
		subject: "the wrapped rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const width = state.widthOf(row);
				if (width <= state.width) continue;
				if (graphemeCount(plainText(row)) <= 1) continue;
				return {
					oracle: "everyWrappedRowFitsTheWidth",
					message: `${label(state)}: row ${index} is ${width} cells wide, past the ${state.width} asked for, and is more than one grapheme: ${JSON.stringify(row)}`,
				};
			}
			return null;
		},
	},
	wrappingKeepsEveryVisibleGlyph: {
		guarantee: "Wrapping moves text to another row. It never drops a glyph, duplicates one, or reorders them.",
		primitives: ["wrap"],
		appliesTo: state => state.width >= 1,
		subject: "the glyphs of the input and of the wrapped rows",
		subjectSize: state => glyphsOf(state.input).length,
		check: state => {
			const before = glyphsOf(state.input);
			const after = state.rows.map(glyphsOf).join("");
			if (before === after) return null;
			return {
				oracle: "wrappingKeepsEveryVisibleGlyph",
				message: `${label(state)}: the wrapped rows carry ${after.length} visible glyphs, the input ${before.length}. Wrapped: ${JSON.stringify(after)}`,
			};
		},
	},
	slicingStaysWithinTheLengthAsked: {
		guarantee:
			"A strict slice paints no more cells than the length asked for. A loose one keeps a straddling grapheme whole, so it may exceed by that one grapheme and no more.",
		primitives: ["slice"],
		subject: "the sliced row",
		subjectSize: rowCount,
		check: state => {
			const row = state.rows[0] ?? "";
			const width = state.widthOf(row);
			const allowance = state.strict ? 0 : 2;
			if (width <= state.width + allowance) return null;
			return {
				oracle: "slicingStaysWithinTheLengthAsked",
				message: `${label(state)}: the ${state.strict ? "strict" : "loose"} slice is ${width} cells wide, past the ${state.width + allowance} it may reach: ${JSON.stringify(row)}`,
			};
		},
	},
	noProducedRowCarriesALineBreak: {
		guarantee: "A row is one line. A carriage return or a line feed inside one moves the cursor and corrupts it.",
		primitives: ["wrap", "slice", "expandTabs"],
		subject: "the produced rows",
		// A slice or a tab expansion of an input that already carries a break is asked to keep it: the
		// break is the caller's, not the primitive's. Only a wrap is asked to remove them.
		subjectSize: state => (state.primitive === "wrap" || !/[\n\r]/.test(state.input) ? rowCount(state) : 0),
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!/[\n\r]/.test(row)) continue;
				return {
					oracle: "noProducedRowCarriesALineBreak",
					message: `${label(state)}: row ${index} carries a line break: ${JSON.stringify(row)}`,
				};
			}
			return null;
		},
	},
	noProducedRowForwardsARawTab: {
		guarantee:
			"A tab in a row is a jump to the next stop, which the layout above it did not account for. A primitive that expands tabs expands every one of them.",
		// The tab expansion has its own guarantee, so each primitive has one owner for a surviving tab.
		primitives: ["wrap", "truncate"],
		subject: "the produced rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!row.includes("\t")) continue;
				return {
					oracle: "noProducedRowForwardsARawTab",
					message: `${label(state)}: row ${index} forwards a raw tab: ${JSON.stringify(row)}`,
				};
			}
			return null;
		},
	},
	noEscapeSequenceIsCutInHalf: {
		guarantee:
			"Every ESC in a produced row begins a complete sequence. A severed one leaves the terminal in whatever state its other half would have closed.",
		primitives: ["truncate", "wrap", "slice"],
		subject: "the escape sequences in the produced rows",
		subjectSize: state => state.rows.filter(row => row.includes("\x1b")).length,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const at = severedEscapeAt(row);
				if (at === -1) continue;
				return {
					oracle: "noEscapeSequenceIsCutInHalf",
					message: `${label(state)}: row ${index} carries an ESC at ${at} that begins no complete sequence: ${JSON.stringify(row)}`,
				};
			}
			return null;
		},
	},
	styleBytesCostNoCells: {
		guarantee: "An escape sequence paints no cell, so styling a string does not change its width.",
		primitives: ["measure"],
		subject: "the measured width of the styled input and of the same text unstyled",
		subjectSize: state => (state.input.length === 0 ? 0 : 1),
		check: state => {
			if (state.measuredWidth === state.measuredPlainWidth) return null;
			return {
				oracle: "styleBytesCostNoCells",
				message: `${label(state)}: measured ${state.measuredWidth} cells styled and ${state.measuredPlainWidth} unstyled; the difference is escape bytes counted as cells.`,
			};
		},
	},
	tabExpansionLeavesNoTab: {
		guarantee: "The tab expansion every renderer is required to call leaves no tab behind.",
		primitives: ["expandTabs"],
		subject: "the expanded row",
		subjectSize: state => (state.input.includes("\t") ? rowCount(state) : 0),
		check: state => {
			const row = state.rows[0] ?? "";
			if (!row.includes("\t")) return null;
			return {
				oracle: "tabExpansionLeavesNoTab",
				message: `${label(state)}: the expansion still carries a tab: ${JSON.stringify(row)}`,
			};
		},
	},
	theHomeDirectoryIsNeverPainted: {
		guarantee: "A shortened path paints no absolute home directory, whatever the operator's home is called.",
		primitives: ["shortenPath"],
		subject: "the shortened path",
		subjectSize: state => (state.homeDir === "" ? 0 : rowCount(state)),
		check: state => {
			const row = state.rows[0] ?? "";
			// The home directory as a path, not as a substring. `/home/opextra/x` is not under
			// `/home/op`, and a check that read it as one called a correctly untouched path a defect.
			const at = row.indexOf(state.homeDir);
			const after = at === -1 ? "" : row.slice(at + state.homeDir.length, at + state.homeDir.length + 1);
			if (at === -1 || (after !== "" && after !== "/")) return null;
			return {
				oracle: "theHomeDirectoryIsNeverPainted",
				message: `${label(state)}: the result paints the home directory ${state.homeDir}: ${JSON.stringify(row)}`,
			};
		},
	},
};

const PROBE: OracleProbe<TextPrimitiveOracleGuarantee, TextPrimitiveOracleFrameState, TextPrimitiveOracleFailure> = {
	appliesTo: (id, state) => {
		const oracle = TEXT_PRIMITIVE_ORACLES[id];
		return oracle.primitives.includes(state.primitive) && (oracle.appliesTo?.(state) ?? true);
	},
	subjectSize: (id, state) => TEXT_PRIMITIVE_ORACLES[id].subjectSize(state),
	check: (id, state) => TEXT_PRIMITIVE_ORACLES[id].check(state),
};

/** Which primitives produce rows at all, for a runner that has to build a state for each. */
export function primitiveProducesRows(primitive: TextPrimitive): boolean {
	return PRODUCES_ROWS.includes(primitive);
}

/** Judge one application of one primitive against every guarantee in the registry. */
export function evaluateAllTextPrimitiveOracles(state: TextPrimitiveOracleFrameState): TextPrimitiveEvaluationResult {
	return evaluateOracleRegistry(TEXT_PRIMITIVE_ORACLE_GUARANTEES, state, PROBE);
}
