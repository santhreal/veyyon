/** ANSI escape primitives for terminal formatting and control sequences. */

/** The escape byte every sequence starts with. */
export const ESC = "\x1b";

/** Control Sequence Introducer, `ESC [`. Starts cursor moves, erasures, and SGR changes. */
export const CSI = "\x1b[";

/** Operating System Command introducer, `ESC ]`. Starts hyperlinks, titles, progress reports. */
export const OSC = "\x1b]";

/** Bell, `0x07`. Legacy OSC terminator accepted by terminals alongside {@link ST}. */
export const BEL = "\x07";

/** String Terminator, `ESC \\`. Ends an OSC, DCS or APC payload. */
export const ST = "\x1b\\";

/** SGR reset, `ESC [ 0 m`. Clears every attribute: color, weight, italics, inverse. */
export const SGR_RESET = "\x1b[0m";

/** Parameterless spelling of SGR reset, `ESC [ m`. */
export const SGR_RESET_SHORT = "\x1b[m";

/** Foreground-color reset, `ESC [ 39 m`. Restores default foreground. */
export const SGR_FG_RESET = "\x1b[39m";

/** Background-color reset, `ESC [ 49 m`. Restores default background. */
export const SGR_BG_RESET = "\x1b[49m";

/** Intensity reset, `ESC [ 22 m`. Cancels both bold and dim. */
export const SGR_INTENSITY_RESET = "\x1b[22m";

/** OSC 66 introducer, `ESC ] 66 ;`. Kitty text-sizing protocol. */
export const OSC66 = "\x1b]66;";
export const OSC66_PREFIX = OSC66;
/** Body of an SGR sequence, `ESC [ <params> m`, with parameters captured. */
export const SGR_SEQUENCE_PATTERN = "\\x1b\\[([0-9;:]*)m";

/** A fresh `RegExp` over {@link SGR_SEQUENCE_PATTERN} with caller-specified flags. */
export function sgrSequence(flags?: string): RegExp {
	return new RegExp(SGR_SEQUENCE_PATTERN, flags);
}
