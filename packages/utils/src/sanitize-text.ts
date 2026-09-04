/**
 * Strip ANSI escape sequences, remove control characters / lone surrogates,
 * and normalize line endings.
 *
 * Bun-native implementation of the former native `sanitizeText` (see
 * `natives/bridge/addon/src/text.rs::sanitize_text`). JavaScript strings are
 * already UTF-16 code-unit arrays. `toWellFormed()` handles the uncommon
 * malformed path; when it changes the input, replacement characters are
 * dropped and the normalized result goes through the well-formed sanitizer.
 *
 * Fast path: well-formed input with no controls or ANSI returns the original
 * string after the control probe.
 */

import { ESC as ESC_CHAR } from "./ansi";

// Well-formed strings only need control/ANSI detection: C0 (excl. \t \n),
// CR, DEL, and C1. ESC (0x1B) is in \x0B-\x1F.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

/**
 * Longest fragment {@link splitTrailingPartialEscape} holds back while a
 * sequence is unfinished. A CSI is a handful of bytes and an OSC title is a
 * line; past this a stream of `ESC` bytes or an unterminated DCS payload would
 * grow the retained fragment without bound, so the caller sanitizes what it has
 * instead of waiting for a terminator that may never arrive.
 */
const MAX_PARTIAL_ESCAPE = 4096;

const BEL_CHAR = "\x07";

/** CSI parameter bytes, `0x30..=0x3f`. */
function isCsiParameter(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= 0x30 && code <= 0x3f;
}

/** CSI intermediate bytes, `0x20..=0x2f`. */
function isCsiIntermediate(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= 0x20 && code <= 0x2f;
}

/**
 * Split a streamed chunk into the part that can be sanitized now and a trailing
 * escape sequence that is still unfinished.
 *
 * {@link sanitizeText} is a pure function of one string, so a reader that ends a
 * chunk inside a sequence used to hand it half a sequence: `ESC [` was consumed
 * as a control fragment and the `0m` that arrived in the next chunk reached the
 * transcript as text (`x\x1b[31mred\x1b[0m` read back as `xred0m`). Whether that
 * happens depends on where the pipe splits, so it shows up as a rare wrong
 * string rather than as a reproducible failure.
 *
 * The scan tracks where the sequence in progress STARTED, so an OSC or DCS
 * string whose payload contains its own `ESC` is retained from its opener rather
 * than from the last escape byte in the chunk. A sequence the grammar rejects
 * (`ESC [` then a byte that is neither parameter, intermediate nor final) ends
 * where it was rejected, matching how the width scanner in `veyyon-text` aborts
 * one.
 *
 * The caller prepends `partial` to its next chunk, and drops it if the stream
 * ends first: a sequence that never completed is not text.
 */
export function splitTrailingPartialEscape(text: string): { head: string; partial: string } {
	if (text.indexOf(ESC_CHAR) === -1) return { head: text, partial: "" };

	let state: "ground" | "esc" | "csi" | "string" | "string-esc" = "ground";
	let start = -1;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		switch (state) {
			case "ground":
				if (char === ESC_CHAR) {
					state = "esc";
					start = index;
				}
				break;
			case "esc":
				if (char === "[") state = "csi";
				else if (char === "]" || char === "P" || char === "X" || char === "^" || char === "_") state = "string";
				else {
					state = "ground";
					start = -1;
				}
				break;
			case "csi":
				if (isCsiParameter(char) || isCsiIntermediate(char)) break;
				state = "ground";
				start = -1;
				break;
			case "string":
				if (char === BEL_CHAR) {
					state = "ground";
					start = -1;
				} else if (char === ESC_CHAR) state = "string-esc";
				break;
			case "string-esc":
				if (char === "\\") {
					state = "ground";
					start = -1;
				} else state = "string";
				break;
		}
	}

	if (start === -1) return { head: text, partial: "" };
	if (text.length - start > MAX_PARTIAL_ESCAPE) return { head: text, partial: "" };
	return { head: text.slice(0, start), partial: text.slice(start) };
}

/**
 * Escape the three XML-significant characters (`&`, `<`, `>`) in text destined
 * for an XML/markup element body. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Quotes are left as-is
 * — use it for element text, not attribute values.
 */
export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

/**
 * Escape XML-significant characters for an attribute VALUE: the three body
 * characters (`&`, `<`, `>`) plus the double quote (`"` → `&quot;`) that would
 * otherwise close the attribute. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Use it for attribute
 * values; {@link escapeXmlText} is for element bodies and leaves `"` intact.
 */
export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}
