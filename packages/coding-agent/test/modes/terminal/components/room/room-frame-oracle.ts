/**
 * How the room suites read a frame: the cells a row shows with the style each
 * is drawn in, the SGR state a row leaves behind, and the frame the engine
 * paints for a fullscreen overlay.
 *
 * The cell reader is an independent SGR interpreter rather than a call into the
 * width or ANSI helpers the painter itself uses, so a defect in those helpers
 * cannot make the painter and its oracle agree by accident.
 */

import { type Component, type OverlayOptions, OverlayStack } from "@veyyon/tui";
import { prepareLinesArray } from "@veyyon/tui/core/renderer";
import { visibleWidth } from "@veyyon/utils/width";

/** One screen cell: its glyph (empty for the right half of a wide glyph) and the style it is drawn in. */
export interface Cell {
	readonly text: string;
	readonly style: string;
}

type SgrState = Map<string, string>;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Attributes an SGR code switches off, by code. */
const SGR_OFF: Record<number, readonly string[]> = {
	22: ["bold", "dim"],
	23: ["italic"],
	24: ["underline"],
	25: ["blink"],
	27: ["inverse"],
	28: ["conceal"],
	29: ["strike"],
	39: ["fg"],
	49: ["bg"],
	55: ["overline"],
	59: ["underline-colour"],
};

/** Attributes an SGR code switches on, by code. */
const SGR_ON: Record<number, string> = {
	1: "bold",
	2: "dim",
	3: "italic",
	4: "underline",
	5: "blink",
	6: "blink",
	7: "inverse",
	8: "conceal",
	9: "strike",
	21: "underline",
	53: "overline",
};

const EXTENDED_COLOUR: Record<number, string> = { 38: "fg", 48: "bg", 58: "underline-colour" };

function applySgr(state: SgrState, params: string): void {
	if (params === "") {
		state.clear();
		return;
	}
	const parts = params.split(";");
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part.includes(":")) {
			const [head, ...rest] = part.split(":");
			const code = Number(head === "" ? "0" : head);
			const slot = EXTENDED_COLOUR[code];
			if (slot) state.set(slot, rest.join(":"));
			else if (code === 4) {
				if (rest[0] === "0") state.delete("underline");
				else state.set("underline", rest.join(":"));
			} else state.set(`unknown:${part}`, "on");
			continue;
		}
		const code = part === "" ? 0 : Number(part);
		const slot = EXTENDED_COLOUR[code];
		if (slot) {
			const mode = parts[i + 1];
			const length = mode === "5" ? 2 : mode === "2" ? 4 : 1;
			state.set(slot, parts.slice(i + 1, i + 1 + length).join(";"));
			i += length;
			continue;
		}
		if (code === 0) state.clear();
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.set("fg", String(code));
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.set("bg", String(code));
		else if (SGR_ON[code]) state.set(SGR_ON[code]!, String(code));
		else if (SGR_OFF[code]) for (const name of SGR_OFF[code]!) state.delete(name);
		else state.set(`unknown:${code}`, "on");
	}
}

function styleOf(state: SgrState): string {
	return [...state.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${value}`)
		.join(" ");
}

/**
 * Every escape sequence a row can carry: a CSI (SGR among them), an OSC ended
 * by BEL or ST, or a two-byte escape. Group 1 is an SGR's parameters, group 2
 * an OSC 8 hyperlink's target.
 */
const ESCAPE =
	/\x1b(?:\[([0-9;:]*)m|\[[0-9;:<=>?]*[ -/]*[@-~]|\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

function apply(state: SgrState, match: RegExpExecArray): void {
	if (match[1] !== undefined) applySgr(state, match[1]);
	else if (match[2] === "") state.delete("link");
	else if (match[2] !== undefined) state.set("link", match[2]);
}

/**
 * The style a row leaves open at its end, as a sorted `name=value` list; the
 * empty string means every attribute it set was reset. A row that ends open
 * paints its colour or weight into whatever the terminal draws next.
 */
export function openStyleAtEnd(row: string): string {
	if (!row.includes("\x1b")) return "";
	const state: SgrState = new Map();
	for (const match of row.matchAll(ESCAPE)) apply(state, match);
	return styleOf(state);
}

/** Every cell a row shows, left to right, with the style it is drawn in. */
export function rowCells(row: string): Cell[] {
	const cells: Cell[] = [];
	const state: SgrState = new Map();
	const push = (text: string): void => {
		if (text === "") return;
		const style = styleOf(state);
		for (const { segment } of segmenter.segment(text)) {
			const code = segment.charCodeAt(0);
			const width = segment.length === 1 && code >= 0x20 && code < 0x7f ? 1 : visibleWidth(segment);
			if (width === 0) {
				const previous = cells.pop();
				cells.push(previous ? { text: previous.text + segment, style: previous.style } : { text: segment, style });
				continue;
			}
			cells.push({ text: segment, style });
			for (let k = 1; k < width; k++) cells.push({ text: "", style });
		}
	};
	let last = 0;
	for (const match of row.matchAll(ESCAPE)) {
		push(row.slice(last, match.index));
		apply(state, match);
		last = match.index + match[0].length;
	}
	push(row.slice(last));
	return cells;
}

/** The plain text of cells, a wide glyph once. */
export function cellText(cells: readonly Cell[]): string {
	return cells.map(cell => cell.text).join("");
}

/**
 * The overlay options the room controller shows the stage with
 * (`RoomController.#showStage`): the whole terminal, from the top-left corner,
 * on the alternate screen.
 */
export const ROOM_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "top-left",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
};

/**
 * The frame the engine paints for the stage's `rows` on a `width`×`height`
 * terminal: the same composite over a blank base and the same line
 * preparation `TUI.#renderAltFrame` runs for a fullscreen overlay.
 */
export function paintedFrame(rows: readonly string[], width: number, height: number): string[] {
	const stack = new OverlayStack({ columns: width, rows: height });
	const component: Component = { render: () => rows };
	stack.push({ component, options: ROOM_OVERLAY_OPTIONS, preFocus: null, hidden: false, exiting: false });
	const base: string[] = new Array(height).fill("");
	return prepareLinesArray(stack.compositeIntoWindow(base, width, height, height), width);
}
