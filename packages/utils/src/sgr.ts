/**
 * Carrying an SGR styling run across a cut, and re-opening a background that the
 * content inside it reset.
 *
 * A renderer that slices a styled line has to replay the style state that was open
 * where it cut, or the remainder renders unstyled. These are the string rewrites
 * that state is carried by. No terminal I/O.
 */

import { ESC, SGR_BG_RESET, SGR_RESET, SGR_RESET_SHORT, sgrEnd } from "./ansi";
import { padding } from "./padding";
import { visibleWidth } from "./width";

/**
 * The attributes an SGR parameter sets, one slot each: a parameter replaces whatever its slot held, and an off
 * code empties its slots. Slots follow ECMA-48 and the xterm extensions (overline, underline color).
 */
const BOLD = 0;
const DIM = 1;
const ITALIC = 2;
const UNDERLINE = 3;
const BLINK = 4;
const INVERSE = 5;
const HIDDEN = 6;
const STRIKE = 7;
const FOREGROUND = 8;
const BACKGROUND = 9;
const FONT = 10;
const FRAKTUR = 11;
const PROPORTIONAL = 12;
const FRAME = 13;
const OVERLINE = 14;
const UNDERLINE_COLOR = 15;
const IDEOGRAM = 16;
const SCRIPT = 17;
/** A parameter no slot holds (an unknown code, a color with missing channels): kept as written until a full reset. */
const UNKNOWN = -1;

/** One attribute still set, and the parameter text that set it. */
interface SetParam {
	readonly slot: number;
	readonly param: string;
}

function setSlot(set: SetParam[], slot: number, param: string): void {
	for (let i = 0; i < set.length; i++) {
		if (set[i]!.slot === slot) {
			set[i] = { slot, param };
			return;
		}
	}
	set.push({ slot, param });
}

function clearSlot(set: SetParam[], slot: number): void {
	for (let i = 0; i < set.length; i++) {
		if (set[i]!.slot === slot) {
			set.splice(i, 1);
			return;
		}
	}
}

/** Keep a parameter no slot holds, once however often the text repeats it. */
function keepUnknown(set: SetParam[], param: string): void {
	for (const entry of set) if (entry.slot === UNKNOWN && entry.param === param) return;
	set.push({ slot: UNKNOWN, param });
}

/**
 * Index of the `;` closing each field of the sequence being applied, then its end. Module scope and refilled per
 * sequence, so applying one allocates nothing for a field it only reads.
 */
const fieldEnds: number[] = [];

/** The code a field opens with: its digits up to the first `:`, and 0 for an empty field. */
function fieldCode(text: string, start: number, end: number): number {
	let code = 0;
	for (let at = start; at < end; at++) {
		const char = text.charCodeAt(at);
		if (char === 0x3a) break;
		code = code * 10 + (char - 0x30);
	}
	return code;
}

/** Index of the first `:` in the field `[start, end)`, or -1. */
function fieldColon(text: string, start: number, end: number): number {
	for (let at = start; at < end; at++) if (text.charCodeAt(at) === 0x3a) return at;
	return -1;
}

/** Whether the field `[start, end)` is the one digit `digit`. */
function fieldIs(text: string, start: number, end: number, digit: number): boolean {
	return end - start === 1 && text.charCodeAt(start) === digit;
}

/** Whether the colon subparameter `[start, end)` reads as zero: empty, or zeros and nothing else. */
function subparamIsZero(text: string, start: number, end: number): boolean {
	for (let at = start; at < end; at++) if (text.charCodeAt(at) !== 0x30) return false;
	return true;
}

/** Apply the SGR parameters `text[start, end)` (between `ESC [` and `m`) to the attributes in `set`. */
function applySgrParams(set: SetParam[], text: string, start: number, end: number): void {
	fieldEnds.length = 0;
	for (let at = start; at < end; at++) if (text.charCodeAt(at) === 0x3b) fieldEnds.push(at);
	fieldEnds.push(end);
	for (let i = 0, from = start; i < fieldEnds.length; from = fieldEnds[i]! + 1, i++) {
		const to = fieldEnds[i]!;
		const colon = fieldColon(text, from, to);
		const hasColon = colon !== -1;
		const code = fieldCode(text, from, to);
		switch (code) {
			case 0:
				set.length = 0;
				break;
			case 1:
				setSlot(set, BOLD, text.slice(from, to));
				break;
			case 2:
				setSlot(set, DIM, text.slice(from, to));
				break;
			case 22:
				clearSlot(set, BOLD);
				clearSlot(set, DIM);
				break;
			case 3:
				setSlot(set, ITALIC, text.slice(from, to));
				break;
			case 20:
				setSlot(set, FRAKTUR, text.slice(from, to));
				break;
			case 23:
				clearSlot(set, ITALIC);
				clearSlot(set, FRAKTUR);
				break;
			case 4:
				// `4:0` is the colon spelling of "no underline"; `4:1` to `4:5` pick a style.
				if (hasColon && subparamIsZero(text, colon + 1, to)) clearSlot(set, UNDERLINE);
				else setSlot(set, UNDERLINE, text.slice(from, to));
				break;
			case 21:
				setSlot(set, UNDERLINE, text.slice(from, to));
				break;
			case 24:
				clearSlot(set, UNDERLINE);
				break;
			case 5:
			case 6:
				setSlot(set, BLINK, text.slice(from, to));
				break;
			case 25:
				clearSlot(set, BLINK);
				break;
			case 7:
				setSlot(set, INVERSE, text.slice(from, to));
				break;
			case 27:
				clearSlot(set, INVERSE);
				break;
			case 8:
				setSlot(set, HIDDEN, text.slice(from, to));
				break;
			case 28:
				clearSlot(set, HIDDEN);
				break;
			case 9:
				setSlot(set, STRIKE, text.slice(from, to));
				break;
			case 29:
				clearSlot(set, STRIKE);
				break;
			case 10:
				clearSlot(set, FONT);
				break;
			case 26:
				setSlot(set, PROPORTIONAL, text.slice(from, to));
				break;
			case 50:
				clearSlot(set, PROPORTIONAL);
				break;
			case 51:
			case 52:
				setSlot(set, FRAME, text.slice(from, to));
				break;
			case 54:
				clearSlot(set, FRAME);
				break;
			case 53:
				setSlot(set, OVERLINE, text.slice(from, to));
				break;
			case 55:
				clearSlot(set, OVERLINE);
				break;
			case 65:
				clearSlot(set, IDEOGRAM);
				break;
			case 75:
				clearSlot(set, SCRIPT);
				break;
			case 39:
				clearSlot(set, FOREGROUND);
				break;
			case 49:
				clearSlot(set, BACKGROUND);
				break;
			case 59:
				clearSlot(set, UNDERLINE_COLOR);
				break;
			case 38:
			case 48:
			case 58: {
				const slot = code === 38 ? FOREGROUND : code === 48 ? BACKGROUND : UNDERLINE_COLOR;
				// The colon spelling holds the whole color in this parameter; the semicolon spelling spends the
				// next two (`5;n`) or four (`2;r;g;b`).
				const next = i + 1 < fieldEnds.length ? to + 1 : -1;
				const spent = hasColon
					? 0
					: next !== -1 && fieldIs(text, next, fieldEnds[i + 1]!, 0x35)
						? 2
						: next !== -1 && fieldIs(text, next, fieldEnds[i + 1]!, 0x32)
							? 4
							: -1;
				if (spent === -1 || i + spent >= fieldEnds.length) {
					// A terminal reads the rest of this sequence however it reads it; replay it as written.
					keepUnknown(set, text.slice(from, end));
					return;
				}
				setSlot(set, slot, text.slice(from, fieldEnds[i + spent]));
				i += spent;
				break;
			}
			default:
				if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
					setSlot(set, FOREGROUND, text.slice(from, to));
				else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
					setSlot(set, BACKGROUND, text.slice(from, to));
				else if (code >= 11 && code <= 19) setSlot(set, FONT, text.slice(from, to));
				else if (code >= 60 && code <= 64) setSlot(set, IDEOGRAM, text.slice(from, to));
				else if (code === 73 || code === 74) setSlot(set, SCRIPT, text.slice(from, to));
				else keepUnknown(set, text.slice(from, to));
		}
	}
}

/**
 * Re-open `background` after every reset in `text`, so a painted ground survives its content.
 *
 * A component that paints a background behind a row cannot trust the row: an inner
 * `ESC [ 0 m` from a reverse-video cursor, a themed span, or a wrapped tool output clears the
 * background from that point on and punches a hole in the ground for the rest of the line. The
 * fix is to re-emit the background immediately after each reset, which is what every painter
 * here was already doing, separately.
 *
 * THREE COPIES, THREE DIFFERENT ANSWERS, which is why this is one function now.
 * `coding-agent/src/modes/terminal/draw/output-block.ts` handled `ESC [ 0 m` and `ESC [ 49 m`,
 * `tui/src/components/editor.ts` handled only `ESC [ 0 m`, and
 * `coding-agent/src/modes/terminal/components/chrome/sun.ts` handled both but DROPPED the `ESC [ 49 m` instead
 * of keeping it. None of the three handled `ESC [ m`, the parameterless reset, which means the
 * same hole for content that happens to spell its reset the short way. Each miss is a visible
 * defect in one surface and not in the others, which is the shape a reader has no way to
 * notice from any single site.
 *
 * All three resets are KEPT and the background re-emitted after them. Keeping the reset matters
 * for `ESC [ 0 m`, which the content emitted to clear its foreground as well; for `ESC [ 49 m`
 * it makes no visible difference, because the background that follows overrides it either way,
 * and one rule is easier to read than two.
 *
 * One left-to-right read inserts the background once after each reset in `text`; a background
 * that is itself a reset is never read as another one. A row with no reset is returned as is.
 */
export function reopenBackgroundAfterResets(text: string, background: string): string {
	if (!text.includes(SGR_RESET) && !text.includes(SGR_RESET_SHORT) && !text.includes(SGR_BG_RESET)) return text;
	let out = "";
	let copied = 0;
	for (let esc = text.indexOf(ESC); esc !== -1; esc = text.indexOf(ESC, esc + 1)) {
		const end = sgrResetEnd(text, esc);
		if (end === -1) continue;
		out += text.slice(copied, end) + background;
		copied = end;
	}
	return out + text.slice(copied);
}

/**
 * End of the reset starting at the `ESC` at `esc` (`SGR_RESET_SHORT`, `SGR_RESET` or `SGR_BG_RESET`),
 * or -1. Compares code units rather than calling `startsWith` three times per escape, which a styled
 * row holds dozens of.
 */
function sgrResetEnd(text: string, esc: number): number {
	if (text.charCodeAt(esc + 1) !== 0x5b) return -1;
	const first = text.charCodeAt(esc + 2);
	if (first === 0x6d) return esc + 3;
	if (first === 0x30) return text.charCodeAt(esc + 3) === 0x6d ? esc + 4 : -1;
	if (first === 0x34 && text.charCodeAt(esc + 3) === 0x39) return text.charCodeAt(esc + 4) === 0x6d ? esc + 5 : -1;
	return -1;
}

/**
 * Advance an SGR carry across `text`: the returned string, replayed at the start of whatever follows `text`,
 * restores the styling state set at its end.
 *
 * The carry is one sequence holding, for each attribute still set, the parameter that last set it, so it is
 * bounded by the attributes a terminal has rather than by the text it crossed. Theme styling closes each span
 * with the attribute's own off code (`ESC [ 39 m`, `ESC [ 22 m`), never a full reset, and a carry that kept
 * every sequence since the last `ESC [ 0 m` grew with every span: a streamed `Text` replays its carry into the
 * wrap of each new line, and streaming 2000 styled lines took 17 s.
 */
export function sgrCarryAfter(carry: string, text: string): string {
	// A canonical carry is unchanged by text that sets nothing.
	const first = text.indexOf(ESC);
	if (first === -1) return carry;
	const set: SetParam[] = [];
	applySgrSequences(set, carry, carry.indexOf(ESC));
	applySgrSequences(set, text, first);
	if (set.length === 0) return "";
	let params = set[0]!.param;
	for (let i = 1; i < set.length; i++) params += `;${set[i]!.param}`;
	return `${ESC}[${params}m`;
}

/** Apply every SGR sequence in `text`, from the `ESC` at `esc` on, to the attributes in `set`. */
function applySgrSequences(set: SetParam[], text: string, esc: number): void {
	for (; esc !== -1; esc = text.indexOf(ESC, esc + 1)) {
		const end = sgrEnd(text, esc);
		if (end !== -1) applySgrParams(set, text, esc + 2, end);
	}
}

/** The attributes open at a point in a styled row, advanced one SGR sequence at a time. */
export class SgrState {
	readonly #set: SetParam[] = [];

	/** Close every attribute, as `ESC [ 0 m` does. */
	reset(): void {
		this.#set.length = 0;
	}

	/** Apply the SGR sequence whose `ESC` is at `esc` in `text` and whose `m` is at `end`, as `sgrEnd` reports it. */
	apply(text: string, esc: number, end: number): void {
		applySgrParams(this.#set, text, esc + 2, end);
	}

	/**
	 * Whether a space written now draws anything an erased cell does not: a background, inverse video, an
	 * underline, a strike-through, an overline, a frame or an ideogram line is open, or a parameter this state
	 * does not recognise, which is taken to draw.
	 */
	get marksBlank(): boolean {
		for (const { slot } of this.#set) {
			if (
				slot === BACKGROUND ||
				slot === INVERSE ||
				slot === UNDERLINE ||
				slot === STRIKE ||
				slot === OVERLINE ||
				slot === FRAME ||
				slot === IDEOGRAM ||
				slot === UNKNOWN
			) {
				return true;
			}
		}
		return false;
	}
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	// Apply background to content + padding
	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}
