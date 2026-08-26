/**
 * The defect oracles for the dialog and selector surfaces a question is asked through.
 *
 * WHY THIS REGISTRY EXISTS:
 * The inline-markdown registry beside this one judges the fragment a label renders to, and its ledgers
 * record that a fragment forwards a line break, a raw tab, a control byte and an escape sequence. That
 * is a claim about a string. This registry is the claim about the screen: the component that paints
 * that fragment has already drawn a card border, reserved a body width, and placed a caret, and what
 * matters to somebody looking at the terminal is whether the card survived the label.
 *
 * The two are not the same test. A caller could sanitize what it was handed, in which case the
 * fragment's defect never reaches a row; or a caller could take a clean fragment and break the row
 * itself by mismeasuring it. Neither registry can see the other's half.
 *
 * WHAT A STATE IS:
 * One component mounted with one set of labels, rendered at one width, plus the renders it has to agree
 * with: the same component rendered again, and the same component rendered at another width and back.
 * A guarantee that needs a comparison reads it from the state rather than rendering again, so an oracle
 * never drives the component it is judging.
 *
 * WHAT IS NOT JUDGED HERE:
 * Which rows the component chose to paint. Whether the option list scrolled to the right offset,
 * whether the recommended option is marked, and which shortcut chips the footer shows are decisions
 * with their own tests. These oracles read what every painted row has to satisfy whatever the component
 * decided: it fits, it is one line, it carries no byte that moves the cursor, and it keeps its card.
 */

import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const DIALOG_RENDER_ORACLE_GUARANTEES = [
	"everyPaintedRowFitsTheWidthItWasRenderedFor",
	"noPaintedRowCarriesALineBreak",
	"noPaintedRowForwardsARawTab",
	"noPaintedRowSeversAnEscapeSequence",
	"noLabelSuppliedEscapeSurvivesIntoARow",
	"everyRowOfTheCardIsTheSameWidth",
	"theCardBorderIsClosedOnEveryBodyRow",
	"aSecondRenderPaintsTheSameRows",
	"aResizedComponentReturnsToItsFirstRows",
	"noRowPaintsTheHomeDirectoryPath",
] as const;

export type DialogRenderOracleGuarantee = (typeof DIALOG_RENDER_ORACLE_GUARANTEES)[number];

/** One dialog render, and the renders it has to agree with. */
export interface DialogRenderOracleFrameState {
	/** Which component was mounted, for a failure that names the surface. */
	surface: string;
	/** The label set the component was mounted with, for a failure that names the input. */
	fixture: string;
	/** The width the rows were rendered for. */
	width: number;
	/**
	 * The escape-carrying strings the labels supplied, which is what the content-escape guarantee looks
	 * for in a row. Derived from the fixture rather than listed, so a fixture that stops carrying one
	 * makes the guarantee stand down rather than pass vacuously.
	 */
	labelSuppliedEscapes: readonly string[];
	/** The home directory as the process sees it, empty when there is none to leak. */
	homeDirectory: string;
	/** The painted rows. */
	rows: readonly string[];
	/** The same component rendered a second time at the same width. */
	rowsFromASecondRender: readonly string[];
	/** The same component rendered at another width and back, or null when it was not driven. */
	rowsAfterAResize: readonly string[] | null;
	/** Whether the component draws a card, which is what the border guarantees read. */
	carded: boolean;
	/** The product's own width function, so an oracle measures a row the way the product does. */
	widthOf: (text: string) => number;
}

export interface DialogRenderOracleFailure {
	oracle: DialogRenderOracleGuarantee;
	message: string;
}

export type DialogRenderEvaluationResult = DefectEvaluation<DialogRenderOracleGuarantee, DialogRenderOracleFailure>;

const CSI = /^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/;
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const SHORT_ESCAPE = /^\x1b(?![[\]])[ -/]*[0-~]/;

/** Strip every complete escape sequence, leaving the cells a row paints. */
export function plainDialogRow(row: string): string {
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

/** The glyphs a card draws its left and right edge with. */
const BORDER_LEFT = /[│├└┌]/;
const BORDER_RIGHT = /[│┤┘┐]/;

/** The rows that carry a card edge on both sides, which is what a body row is. */
function cardBodyRows(rows: readonly string[]): readonly { index: number; cells: string }[] {
	const body: { index: number; cells: string }[] = [];
	for (const [index, row] of rows.entries()) {
		const cells = plainDialogRow(row).trimEnd();
		const trimmed = cells.trimStart();
		if (trimmed.length < 2) continue;
		if (!BORDER_LEFT.test(trimmed[0] ?? "")) continue;
		body.push({ index, cells });
	}
	return body;
}

function firstDifference(left: readonly string[], right: readonly string[]): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index++) {
		if (left[index] !== right[index]) return index;
	}
	return left.length === right.length ? -1 : shared;
}

function label(state: DialogRenderOracleFrameState): string {
	return `${state.surface}/${state.fixture}@${state.width}`;
}

interface DialogRenderOracle {
	guarantee: string;
	appliesTo: (state: DialogRenderOracleFrameState) => boolean;
	subject: string;
	subjectSize: (state: DialogRenderOracleFrameState) => number;
	check: (state: DialogRenderOracleFrameState) => DialogRenderOracleFailure | null;
}

const always = (): boolean => true;
const rowCount = (state: DialogRenderOracleFrameState): number => state.rows.length;

export const DIALOG_RENDER_ORACLES: Readonly<Record<DialogRenderOracleGuarantee, DialogRenderOracle>> = {
	everyPaintedRowFitsTheWidthItWasRenderedFor: {
		guarantee:
			"A row wider than the terminal wraps, and the wrapped remainder pushes every row below it down by one. The component was told the width, so a row over it is the component's own measurement being wrong.",
		appliesTo: always,
		subject: "the painted rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const painted = state.widthOf(row);
				if (painted <= state.width) continue;
				return {
					oracle: "everyPaintedRowFitsTheWidthItWasRenderedFor",
					message: `${label(state)}: row ${index} paints ${painted} cells into ${state.width}: ${JSON.stringify(plainDialogRow(row).slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noPaintedRowCarriesALineBreak: {
		guarantee:
			"A painted row is one line. A break inside one moves the cursor and every row the component placed below it lands one row lower than the geometry it reported.",
		appliesTo: always,
		subject: "the painted rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!/[\n\r]/.test(row)) continue;
				return {
					oracle: "noPaintedRowCarriesALineBreak",
					message: `${label(state)}: row ${index} carries a line break: ${JSON.stringify(plainDialogRow(row).slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noPaintedRowForwardsARawTab: {
		guarantee:
			"A tab jumps to the next stop rather than advancing one cell, so a row carrying one lands past the card's right edge and measures narrower than it paints.",
		appliesTo: always,
		subject: "the painted rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!row.includes("\t")) continue;
				return {
					oracle: "noPaintedRowForwardsARawTab",
					message: `${label(state)}: row ${index} forwards a raw tab: ${JSON.stringify(plainDialogRow(row).slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	noPaintedRowSeversAnEscapeSequence: {
		guarantee:
			"Every ESC in a row begins a complete sequence. A row that forwards one unterminated leaves the terminal consuming the rows below it as sequence parameters.",
		appliesTo: state => state.rows.some(row => row.includes("\x1b")),
		subject: "the rows that carry an escape sequence",
		subjectSize: state => state.rows.filter(row => row.includes("\x1b")).length,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				const at = severedEscapeAt(row);
				if (at < 0) continue;
				return {
					oracle: "noPaintedRowSeversAnEscapeSequence",
					message: `${label(state)}: row ${index} severs an escape sequence at ${at}: ${JSON.stringify(row.slice(at, at + 30))}`,
				};
			}
			return null;
		},
	},
	noLabelSuppliedEscapeSurvivesIntoARow: {
		guarantee:
			"An option label comes from a tool call the model wrote and a hook label comes from user configuration. A sequence either of them supplied has to be a cell or be gone, because a surviving one paints in a colour the theme did not pick and can move the cursor out of the card.",
		appliesTo: state => state.labelSuppliedEscapes.length > 0,
		subject: "the escape sequences the labels supplied",
		subjectSize: state => state.labelSuppliedEscapes.length,
		check: state => {
			for (const sequence of state.labelSuppliedEscapes) {
				const index = state.rows.findIndex(row => row.includes(sequence));
				if (index < 0) continue;
				return {
					oracle: "noLabelSuppliedEscapeSurvivesIntoARow",
					message: `${label(state)}: row ${index} carries the label's own ${JSON.stringify(sequence)}`,
				};
			}
			return null;
		},
	},
	everyRowOfTheCardIsTheSameWidth: {
		guarantee:
			"A card is a rectangle. Two body rows of different widths mean the right edge steps in and out down the card, which is what a row measured with a tab or a wide glyph counted wrong looks like.",
		appliesTo: state => state.carded && cardBodyRows(state.rows).length > 1,
		subject: "the body rows of the card",
		subjectSize: state => cardBodyRows(state.rows).length,
		check: state => {
			const body = cardBodyRows(state.rows);
			const widths = new Map<number, number>();
			for (const row of body) {
				const painted = state.widthOf(row.cells);
				if (!widths.has(painted)) widths.set(painted, row.index);
			}
			if (widths.size <= 1) return null;
			const seen = [...widths.entries()].map(([painted, index]) => `${painted} at row ${index}`);
			return {
				oracle: "everyRowOfTheCardIsTheSameWidth",
				message: `${label(state)}: the card's body rows paint ${widths.size} different widths: ${seen.join(", ")}`,
			};
		},
	},
	theCardBorderIsClosedOnEveryBodyRow: {
		guarantee:
			"A body row that opens a card edge closes it. An unclosed one is the card's right edge missing on that row, which is what a label wider than the body width does when the component appends it without truncating.",
		appliesTo: state => state.carded && cardBodyRows(state.rows).length > 0,
		subject: "the body rows of the card",
		subjectSize: state => cardBodyRows(state.rows).length,
		check: state => {
			for (const row of cardBodyRows(state.rows)) {
				const cells = row.cells.trimStart();
				const last = cells[cells.length - 1] ?? "";
				if (BORDER_RIGHT.test(last)) continue;
				return {
					oracle: "theCardBorderIsClosedOnEveryBodyRow",
					message: `${label(state)}: row ${row.index} opens a card edge and ends with ${JSON.stringify(last)}: ${JSON.stringify(cells.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	aSecondRenderPaintsTheSameRows: {
		guarantee:
			"A dialog re-renders on every keystroke and on every pointer report. A second render that differs means the card changes under a caret that did not move.",
		appliesTo: always,
		subject: "the rows against a second render of the same component",
		subjectSize: rowCount,
		check: state => {
			const at = firstDifference(state.rows, state.rowsFromASecondRender);
			if (at < 0) return null;
			return {
				oracle: "aSecondRenderPaintsTheSameRows",
				message: `${label(state)}: a second render differs at row ${at}: ${JSON.stringify(plainDialogRow(state.rows[at] ?? "").slice(0, 60))} against ${JSON.stringify(plainDialogRow(state.rowsFromASecondRender[at] ?? "").slice(0, 60))}`,
			};
		},
	},
	aResizedComponentReturnsToItsFirstRows: {
		guarantee:
			"A terminal resize is a width change and a change back is a width change too. A component whose per-width caches disagree with a fresh render paints the old geometry into the new one.",
		appliesTo: state => state.rowsAfterAResize !== null,
		subject: "the rows against the rows after a resize and back",
		subjectSize: state => state.rowsAfterAResize?.length ?? 0,
		check: state => {
			const after = state.rowsAfterAResize;
			if (after === null) return null;
			const at = firstDifference(state.rows, after);
			if (at < 0) return null;
			return {
				oracle: "aResizedComponentReturnsToItsFirstRows",
				message: `${label(state)}: a resize and back differs at row ${at}: ${JSON.stringify(plainDialogRow(state.rows[at] ?? "").slice(0, 60))} against ${JSON.stringify(plainDialogRow(after[at] ?? "").slice(0, 60))}`,
			};
		},
	},
	noRowPaintsTheHomeDirectoryPath: {
		guarantee:
			"A dialog is what a session recording and a screen share show. A row that paints the home directory in full leaks the account name to whoever is watching, which is why the product has a path shortener.",
		appliesTo: state => state.homeDirectory.length > 0,
		subject: "the painted rows",
		subjectSize: rowCount,
		check: state => {
			for (const [index, row] of state.rows.entries()) {
				if (!plainDialogRow(row).includes(state.homeDirectory)) continue;
				return {
					oracle: "noRowPaintsTheHomeDirectoryPath",
					message: `${label(state)}: row ${index} paints ${JSON.stringify(state.homeDirectory)} in full: ${JSON.stringify(plainDialogRow(row).slice(0, 60))}`,
				};
			}
			return null;
		},
	},
};

const PROBE: OracleProbe<DialogRenderOracleGuarantee, DialogRenderOracleFrameState, DialogRenderOracleFailure> = {
	appliesTo: (id, state) => DIALOG_RENDER_ORACLES[id].appliesTo(state),
	subjectSize: (id, state) => DIALOG_RENDER_ORACLES[id].subjectSize(state),
	check: (id, state) => DIALOG_RENDER_ORACLES[id].check(state),
};

/** Judge one dialog render against every guarantee in the registry. */
export function evaluateAllDialogRenderOracles(state: DialogRenderOracleFrameState): DialogRenderEvaluationResult {
	return evaluateOracleRegistry(DIALOG_RENDER_ORACLE_GUARANTEES, state, PROBE);
}
