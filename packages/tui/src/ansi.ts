export const ESC = "\x1b";

export const CSI = "\x1b[";

export const OSC = "\x1b]";

export const BEL = "\x07";

export const ST = "\x1b\\";

export const SGR_RESET = "\x1b[0m";

export const SGR_RESET_SHORT = "\x1b[m";

export const SGR_FG_RESET = "\x1b[39m";

export const SGR_BG_RESET = "\x1b[49m";

export const SGR_INTENSITY_RESET = "\x1b[22m";

export const OSC66 = "\x1b]66;";
export const OSC66_PREFIX = OSC66;
export const SGR_SEQUENCE_PATTERN = "\\x1b\\[([0-9;:]*)m";

export function sgrSequence(flags?: string): RegExp {
	return new RegExp(SGR_SEQUENCE_PATTERN, flags);
}
