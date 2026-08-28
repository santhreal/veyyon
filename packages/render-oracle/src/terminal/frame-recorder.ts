import type { VirtualTerminal } from "./virtual-terminal";

const ERASE_DISPLAY_REGEX = /\x1b\[[0-3]?J/g;
const ERASE_LINE_REGEX = /\x1b\[[0-2]?K/g;
/** CSI/OSC/APC/DCS sequences, which move and style but print nothing. */
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_^][^\x1b]*\x1b\\|.)/gu;
/** Anything that leaves a glyph on the grid once the escapes are gone. */
const PRINTABLE_ROW_CONTENT = /[^\x00-\x1f\x7f]/u;

/** What one render wrote to the terminal, and what it cost the screen. */
export interface FrameEmission {
	/** Every byte the render wrote, in order. */
	raw: string;
	/** Size of {@link raw} in UTF-8 bytes. A frame that wrote nothing is 0. */
	byteLength: number;
	/** Erase-in-display sequences (`CSI J`) the render emitted. */
	eraseDisplayCount: number;
	/** Erase-in-line sequences (`CSI K`) the render emitted. */
	eraseLineCount: number;
	/**
	 * Rows whose glyphs the render actually reprinted. A row-walk that steps over an unchanged
	 * row emits only the `\r\n` that moves to the next one, so it does not count here — which is
	 * what separates a targeted repaint from a full-window sweep that repaints identical rows.
	 */
	rowsRewritten: number;
	/** The grid after the render, one string per viewport row. */
	viewport: string[];
}

/**
 * Record what each render writes to `term`, without changing what the terminal does with it.
 *
 * A flicker oracle reads two things: the grid, which says what the user ended up looking at, and
 * the byte stream, which says what it cost to get there. Two frames can agree on the grid and
 * disagree entirely on the stream, and that gap — an identical frame that erased and reprinted
 * the viewport to arrive back where it started — is the defect. So the recorder keeps the stream
 * per frame rather than in one running total.
 *
 * `collectFrame` drains the buffer, so each call reports one render's emission and never the
 * accumulated history.
 */
export function createFrameRecorder(term: VirtualTerminal): { collectFrame: () => FrameEmission } {
	let currentBuffer = "";
	const originalWrite = term.write.bind(term);
	term.write = (data: string): void => {
		currentBuffer += data;
		originalWrite(data);
	};

	return {
		collectFrame: (): FrameEmission => {
			const raw = currentBuffer;
			currentBuffer = "";
			return {
				raw,
				byteLength: Buffer.byteLength(raw, "utf8"),
				eraseDisplayCount: raw.match(ERASE_DISPLAY_REGEX)?.length ?? 0,
				eraseLineCount: raw.match(ERASE_LINE_REGEX)?.length ?? 0,
				rowsRewritten: raw
					.split("\r\n")
					.filter(segment => PRINTABLE_ROW_CONTENT.test(segment.replace(ESCAPE_SEQUENCE, ""))).length,
				viewport: term.getViewport(),
			};
		},
	};
}
