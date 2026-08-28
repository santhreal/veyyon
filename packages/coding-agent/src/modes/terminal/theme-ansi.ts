/**
 * `PresentationTheme` hex roles to SGR sequences.
 *
 * The wire theme is device-independent by design: it states `#rrggbb` and a
 * weight, and every renderer converts on the way out. This is the terminal's
 * conversion, and it is the only place in the terminal renderer that reads a
 * hex colour.
 *
 * `Bun.color` is the encoder because nothing portable turns a CSS colour into
 * either a 24-bit or a 256-colour SGR sequence, and which of the two to emit is
 * a property of the probed device, held by `@veyyon/utils/color-format`.
 */

import { SGR_RESET } from "@veyyon/utils/ansi";
import { getAnsiColorFormat } from "@veyyon/utils/color-format";
import type { HexColor, StyleRole, TextStyle } from "@veyyon/wire/presentation";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKETHROUGH = "\x1b[9m";

/**
 * Encoded sequences by colour and channel. A theme has a few dozen roles and a
 * frame paints thousands of runs, so the conversion is memoized rather than run
 * per row. Cleared when the encoding changes, because the same hex maps to a
 * different sequence under `ansi-256`.
 */
const foregrounds = new Map<HexColor, string>();
const backgrounds = new Map<HexColor, string>();
let cachedFormat = getAnsiColorFormat();

function invalidateOnFormatChange(): void {
	const format = getAnsiColorFormat();
	if (format === cachedFormat) return;
	cachedFormat = format;
	foregrounds.clear();
	backgrounds.clear();
}

/** Foreground SGR for a hex colour, or the empty string when it does not parse. */
export function foregroundSequence(color: HexColor): string {
	invalidateOnFormatChange();
	const memo = foregrounds.get(color);
	if (memo !== undefined) return memo;
	const encoded = Bun.color(color, cachedFormat) ?? "";
	foregrounds.set(color, encoded);
	return encoded;
}

/**
 * Background SGR for a hex colour. `Bun.color` encodes foregrounds, so the
 * channel is switched by moving the parameter from the 38 family to the 48 one;
 * that is the only difference between the two sequences.
 */
export function backgroundSequence(color: HexColor): string {
	invalidateOnFormatChange();
	const memo = backgrounds.get(color);
	if (memo !== undefined) return memo;
	const foreground = Bun.color(color, cachedFormat) ?? "";
	const encoded = foreground.startsWith("\x1b[38;") ? `\x1b[48;${foreground.slice(5)}` : "";
	backgrounds.set(color, encoded);
	return encoded;
}

function styleSequence(style: TextStyle | undefined): string {
	if (style === undefined) return "";
	let sequence = "";
	if (style.bold === true) sequence += BOLD;
	if (style.dim === true) sequence += DIM;
	if (style.italic === true) sequence += ITALIC;
	if (style.underline === true) sequence += UNDERLINE;
	if (style.strikethrough === true) sequence += STRIKETHROUGH;
	return sequence;
}

/** The opening sequence for a role: colour, ground and weight in one string. */
export function roleSequence(role: StyleRole): string {
	let sequence = foregroundSequence(role.fg);
	if (role.bg !== undefined) sequence += backgroundSequence(role.bg);
	return sequence + styleSequence(role.style);
}

/**
 * Paint `text` in `role`. A reset closes the run, so a row built from several
 * roles cannot leak one run's colour into the next, and a row handed to the
 * engine carries no open SGR state.
 */
export function paint(text: string, role: StyleRole): string {
	if (text === "") return "";
	const open = roleSequence(role);
	return open === "" ? text : `${open}${text}${SGR_RESET}`;
}
