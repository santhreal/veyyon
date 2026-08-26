/**
 * The ANSI escape primitives, in the one place their bytes are written. Five byte strings were declared
 * sixteen times under eleven names; this module gives each one name and one spelling. Only primitives that
 * more than one module needs; feature-specific sequences stay with their feature. No imports — reaching for
 * a primitive is always cheaper than retyping it. Exception: `utils/qrcode.ts` keeps its own `ANSI_RESET`
 * (dependency-free), recorded in `packages/tui/test/ansi-owner.test.ts`.
 */

/** The escape byte every sequence below starts with. */
export const ESC = "\x1b";

/** Control Sequence Introducer, `ESC [`. Named CSI (its ANSI name) not `ESC` to avoid ambiguity. */
export const CSI = `${ESC}[`;

/** Operating System Command introducer, `ESC ]`. Starts a hyperlink, a title change, a progress report. */
export const OSC = `${ESC}]`;

/** Bell, `0x07`. Legacy OSC terminator every terminal still accepts in place of {@link ST}. */
export const BEL = "\x07";

/** String Terminator, `ESC \`. Ends an OSC, DCS or APC payload. The standard form a parser must accept. */
export const ST = `${ESC}\\`;

/** SGR reset, `ESC [ 0 m`. Clears every attribute: colour, weight, italics, inverse. */
export const SGR_RESET = `${CSI}0m`;

/**
 * The parameterless spelling of the reset, `ESC [ m`, which means exactly `ESC [ 0 m`. A parser must accept
 * both; this tree emits {@link SGR_RESET} and reads either.
 */
export const SGR_RESET_SHORT = `${CSI}m`;

/** Foreground-colour reset, `ESC [ 39 m`. Restores default foreground, leaves other attributes alone. */
export const SGR_FG_RESET = `${CSI}39m`;

/** Background-colour reset, `ESC [ 49 m`. Counterpart of {@link SGR_FG_RESET}. */
export const SGR_BG_RESET = `${CSI}49m`;

/** Intensity reset, `ESC [ 22 m`. Cancels BOTH bold and dim — no sequence turns off only one. */
export const SGR_INTENSITY_RESET = `${CSI}22m`;

/** OSC 66 introducer, `ESC ] 66 ;`. Kitty's text-sizing protocol for grapheme scaling/width-correction. */
export const OSC66 = `${OSC}66;`;

/**
 * SGR sequence body pattern, `ESC [ <params> m`. A pattern not a `RegExp` — four call sites need three
 * different flag sets. Class stops at `0x30-0x3a` (digits, `;`, `:`) not the full `0x30-0x3f` range,
 * so private-mode sequences are not treated as colour changes.
 */
export const SGR_SEQUENCE_PATTERN = "\\x1b\\[([0-9;:]*)m";

/** A fresh `RegExp` over {@link SGR_SEQUENCE_PATTERN} with the flags the caller needs. */
export function sgrSequence(flags: string): RegExp {
	return new RegExp(SGR_SEQUENCE_PATTERN, flags);
}
