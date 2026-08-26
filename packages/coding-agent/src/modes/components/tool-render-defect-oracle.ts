/**
 * Defect oracles for what a tool renderer paints.
 *
 * The composer and overlay registries judge where the engine puts rows. This one judges the rows
 * themselves, at the seam the repo's sanitization rule covers: every string a tool renderer displays
 * passes through `replaceTabs`, `truncateToWidth` and `shortenPath` before it reaches a cell, and a
 * renderer that forgets one produces a frame the compositor is right to paint and a user cannot read.
 * A raw tab opens a hole the differ cannot account for, a row wider than the render width wraps and
 * shifts every row below it, an unclosed SGR bleeds its colour into the next row, and a home
 * directory path leaks the operator's user name into a transcript that gets pasted into an issue.
 *
 * The subject is a rendered row, so an oracle here reads what `render(width)` returned rather than the
 * terminal grid: a renderer is reached through `toolRenderers`, which is a registry, so the sweep
 * enumerates its members at run time and a new tool is swept the day it is registered.
 *
 * A render that carries a terminal image payload is not text and is excluded by
 * `carriesBinaryPayload`: the bytes of a Kitty or iTerm transmission are neither rows nor styles, and
 * an oracle that read them would report a control character for every image ever painted.
 */

import { stripVTControlCharacters } from "node:util";
import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const TOOL_RENDER_ORACLE_GUARANTEES = [
	"everyRowFitsTheRenderWidth",
	"noRowSmugglesALineBreak",
	"noRawTabReachesTheScreen",
	"noContentSuppliedEscapeSurvives",
	"noHomeDirectoryPathIsPainted",
	"noControlCharacterOtherThanStyle",
] as const;

export type ToolRenderOracleGuarantee = (typeof TOOL_RENDER_ORACLE_GUARANTEES)[number];

/** Which of a renderer's two entry points produced the rows. */
export const TOOL_RENDER_SURFACES = ["call", "result"] as const;

export type ToolRenderSurface = (typeof TOOL_RENDER_SURFACES)[number];

/** One renderer's output for one input, as the component returned it. */
export interface ToolRenderSnapshot {
	/** Registered tool name, which is how a failure names the renderer to fix. */
	tool: string;
	surface: ToolRenderSurface;
	/** Name of the input that produced these rows. */
	fixture: string;
	/** The width the component was asked to paint at. */
	width: number;
	/** Rows exactly as the component returned them, styles intact. */
	rawRows: readonly string[];
	/** The same rows with every escape sequence removed: what the cells show. */
	plainRows: readonly string[];
	/**
	 * True when the render transmits an image, so its bytes are a protocol payload rather than text.
	 *
	 * An image payload is a legitimate escape sequence carrying arbitrary base64, and it is excluded
	 * from every guarantee here rather than judged by one, because the alternative is a suite that
	 * reports a defect for every screenshot the product has ever rendered.
	 */
	carriesBinaryPayload: boolean;
}

export interface ToolRenderOracleFrameState {
	/**
	 * The home directory the fixtures built their paths from.
	 *
	 * A renderer shortens a path with `shortenPath`, which replaces this prefix with `~`. The oracle
	 * reads the prefix from the state rather than from `os.homedir()` so a sweep can drive a path
	 * whose home is not the machine's own.
	 */
	homeDir: string;
	/**
	 * Escape sequences the fixture content supplied, which a row must not carry.
	 *
	 * A tool result is untrusted text: it comes from a model, a file, or a subprocess. The engine
	 * writes a row to the terminal as bytes, so a control sequence a renderer forwards is executed
	 * rather than painted, and `ESC [ 2 J` clears the screen while `ESC ] 0 ;` renames the window.
	 * These are the byte strings the sweep injected, so the oracle judges provenance rather than
	 * guessing which of a row's escapes the renderer meant to emit.
	 */
	forbiddenSequences: readonly string[];
	renders: readonly ToolRenderSnapshot[];
}

export interface ToolRenderOracleFailure {
	oracle: ToolRenderOracleGuarantee;
	message: string;
	details?: Record<string, unknown>;
}

/** Every render whose rows are text an oracle can read. */
function textualRenders(state: ToolRenderOracleFrameState): readonly ToolRenderSnapshot[] {
	return state.renders.filter(render => !render.carriesBinaryPayload);
}

/** Rows across every textual render: the subject all six guarantees read. */
function textualRowCount(state: ToolRenderOracleFrameState): number {
	return textualRenders(state).reduce((total, render) => total + render.rawRows.length, 0);
}

function where(render: ToolRenderSnapshot, row: number): string {
	return `${render.tool}/${render.surface}/${render.fixture} row ${row}`;
}

/**
 * Visible width of a row, in cells.
 *
 * `Bun.stringWidth` is the product's own width function: it counts a wide glyph as two cells and a
 * zero-width joiner as none, which is the arithmetic the compositor does when it decides whether a
 * row wrapped. Node has no equivalent.
 */
function visibleWidth(text: string): number {
	return Bun.stringWidth(text);
}

export function checkEveryRowFitsTheRenderWidth(state: ToolRenderOracleFrameState): ToolRenderOracleFailure | null {
	for (const render of textualRenders(state)) {
		for (const [index, row] of render.plainRows.entries()) {
			const width = visibleWidth(row);
			if (width > render.width) {
				return {
					oracle: "everyRowFitsTheRenderWidth",
					message: `${where(render, index)} is ${width} cells wide at a render width of ${render.width}. The engine truncates it with no ellipsis, so the tail is dropped with nothing on screen saying so. Elide it with truncateToWidth.`,
					details: { tool: render.tool, surface: render.surface, row: index, width, renderWidth: render.width },
				};
			}
		}
	}
	return null;
}

export function checkNoRowSmugglesALineBreak(state: ToolRenderOracleFrameState): ToolRenderOracleFailure | null {
	for (const render of textualRenders(state)) {
		for (const [index, row] of render.rawRows.entries()) {
			const breakAt = row.search(/[\n\r]/);
			if (breakAt >= 0) {
				return {
					oracle: "noRowSmugglesALineBreak",
					message: `${where(render, index)} contains a line break at column ${breakAt}. A row is one line; a renderer that returns two in one string paints a row the differ cannot account for.`,
					details: { tool: render.tool, surface: render.surface, row: index, column: breakAt },
				};
			}
		}
	}
	return null;
}

export function checkNoRawTabReachesTheScreen(state: ToolRenderOracleFrameState): ToolRenderOracleFailure | null {
	for (const render of textualRenders(state)) {
		for (const [index, row] of render.plainRows.entries()) {
			const tabAt = row.indexOf("\t");
			if (tabAt >= 0) {
				return {
					oracle: "noRawTabReachesTheScreen",
					message: `${where(render, index)} contains a raw tab at column ${tabAt}, which the terminal expands to a hole of unpredictable width. Call replaceTabs on the content.`,
					details: { tool: render.tool, surface: render.surface, row: index, column: tabAt },
				};
			}
		}
	}
	return null;
}

export function checkNoContentSuppliedEscapeSurvives(
	state: ToolRenderOracleFrameState,
): ToolRenderOracleFailure | null {
	if (state.forbiddenSequences.length === 0) return null;
	for (const render of textualRenders(state)) {
		for (const [index, row] of render.rawRows.entries()) {
			for (const sequence of state.forbiddenSequences) {
				const at = row.indexOf(sequence);
				if (at >= 0) {
					return {
						oracle: "noContentSuppliedEscapeSurvives",
						message: `${where(render, index)} forwards the control sequence ${JSON.stringify(sequence)} the content supplied, at offset ${at}. The engine writes a row as bytes, so the sequence is executed by the terminal rather than painted as text.`,
						details: { tool: render.tool, surface: render.surface, row: index, offset: at, sequence },
					};
				}
			}
		}
	}
	return null;
}

export function checkNoHomeDirectoryPathIsPainted(state: ToolRenderOracleFrameState): ToolRenderOracleFailure | null {
	if (state.homeDir === "") return null;
	for (const render of textualRenders(state)) {
		for (const [index, row] of render.plainRows.entries()) {
			const at = row.indexOf(state.homeDir);
			if (at >= 0) {
				return {
					oracle: "noHomeDirectoryPathIsPainted",
					message: `${where(render, index)} prints the home directory ${state.homeDir} at column ${at}, which leaks the account name into any transcript that is shared. Shorten it with shortenPath.`,
					details: { tool: render.tool, surface: render.surface, row: index, column: at },
				};
			}
		}
	}
	return null;
}

/**
 * C0 characters a painted row must not carry, with the tab left to its own guarantee.
 *
 * Every one of these moves the cursor or the bell rather than painting a cell: a carriage return
 * rewrites the row from its start, a backspace overstrikes, a vertical tab and a form feed scroll,
 * and a NUL is dropped by some emulators and painted as a space by others.
 */
const FORBIDDEN_CONTROLS: readonly { code: string; name: string }[] = [
	{ code: "\x00", name: "NUL" },
	{ code: "\x07", name: "BEL" },
	{ code: "\b", name: "backspace" },
	{ code: "\v", name: "vertical tab" },
	{ code: "\f", name: "form feed" },
];

export function checkNoControlCharacterOtherThanStyle(
	state: ToolRenderOracleFrameState,
): ToolRenderOracleFailure | null {
	for (const render of textualRenders(state)) {
		for (const [index, row] of render.plainRows.entries()) {
			for (const control of FORBIDDEN_CONTROLS) {
				const at = row.indexOf(control.code);
				if (at >= 0) {
					return {
						oracle: "noControlCharacterOtherThanStyle",
						message: `${where(render, index)} carries a ${control.name} at column ${at}. It survives escape-sequence stripping, so it reaches a cell and moves the cursor instead of painting.`,
						details: {
							tool: render.tool,
							surface: render.surface,
							row: index,
							column: at,
							control: control.name,
						},
					};
				}
			}
		}
	}
	return null;
}

/** One guarantee: when it applies, what it reads, and how it judges. */
export interface ToolRenderOracle {
	id: ToolRenderOracleGuarantee;
	/** What the guarantee promises, in one sentence. */
	description: string;
	appliesTo: (state: ToolRenderOracleFrameState) => boolean;
	subject: (state: ToolRenderOracleFrameState) => number;
	check: (state: ToolRenderOracleFrameState) => ToolRenderOracleFailure | null;
}

/**
 * Every guarantee, keyed by its id.
 *
 * A `Record` over the union for the same reason the other two registries are one: a guarantee
 * declared and left unwired, and an entry with no declared id, are both compile errors.
 */
export const TOOL_RENDER_ORACLES: Readonly<Record<ToolRenderOracleGuarantee, ToolRenderOracle>> = {
	everyRowFitsTheRenderWidth: {
		id: "everyRowFitsTheRenderWidth",
		description: "No rendered row is wider in cells than the render width, which the engine would silently cut.",
		appliesTo: state => textualRenders(state).length > 0,
		subject: textualRowCount,
		check: checkEveryRowFitsTheRenderWidth,
	},
	noRowSmugglesALineBreak: {
		id: "noRowSmugglesALineBreak",
		description: "A rendered row is one line: no row string carries a newline or a carriage return.",
		appliesTo: state => textualRenders(state).length > 0,
		subject: textualRowCount,
		check: checkNoRowSmugglesALineBreak,
	},
	noRawTabReachesTheScreen: {
		id: "noRawTabReachesTheScreen",
		description: "No rendered row carries a raw tab, whose painted width the emulator decides.",
		appliesTo: state => textualRenders(state).length > 0,
		subject: textualRowCount,
		check: checkNoRawTabReachesTheScreen,
	},
	noContentSuppliedEscapeSurvives: {
		id: "noContentSuppliedEscapeSurvives",
		description: "No row carries a control sequence that came from the content the renderer was given.",
		appliesTo: state => state.forbiddenSequences.length > 0 && textualRenders(state).length > 0,
		subject: textualRowCount,
		check: checkNoContentSuppliedEscapeSurvives,
	},
	noHomeDirectoryPathIsPainted: {
		id: "noHomeDirectoryPathIsPainted",
		description: "No rendered row prints the home directory prefix a path should have been shortened to `~`.",
		appliesTo: state => state.homeDir !== "" && textualRenders(state).length > 0,
		subject: textualRowCount,
		check: checkNoHomeDirectoryPathIsPainted,
	},
	noControlCharacterOtherThanStyle: {
		id: "noControlCharacterOtherThanStyle",
		description: "No rendered row carries a C0 control character other than the tab its own guarantee covers.",
		appliesTo: state => textualRenders(state).length > 0,
		subject: textualRowCount,
		check: checkNoControlCharacterOtherThanStyle,
	},
};

export type ToolRenderEvaluationResult = DefectEvaluation<ToolRenderOracleGuarantee, ToolRenderOracleFailure>;

const PROBE: OracleProbe<ToolRenderOracleGuarantee, ToolRenderOracleFrameState, ToolRenderOracleFailure> = {
	appliesTo: (id, state) => TOOL_RENDER_ORACLES[id].appliesTo(state),
	subjectSize: (id, state) => TOOL_RENDER_ORACLES[id].subject(state),
	check: (id, state) => TOOL_RENDER_ORACLES[id].check(state),
};

/** Run every tool-render guarantee over one set of renders. */
export function evaluateAllToolRenderOracles(state: ToolRenderOracleFrameState): ToolRenderEvaluationResult {
	return evaluateOracleRegistry(TOOL_RENDER_ORACLE_GUARANTEES, state, PROBE);
}

/** Strip every escape sequence from a rendered row: what the cells are left showing. */
export function plainRowOf(rawRow: string): string {
	return stripVTControlCharacters(rawRow);
}
