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

	// The one `Bun.stripANSI` call in shipped source. Every tool result passes through here. On 15 KB
	// to 380 KB of styled output the portable `stripAnsi` in `./strip-ansi` measured 1.2 to 1.8 times
	// slower, and `node:util` `stripVTControlCharacters` 13 times slower with DCS payloads left in.
	// Every other caller uses `stripAnsi`, which `scripts/one-owner-calls-bun-strip-ansi.test.ts`
	// enforces.
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

/** Where {@link splitTrailingPartialEscape} is inside an escape sequence it has started. */
type EscapeScan = "esc" | "csi" | "string" | "string-esc";

/** The scan state after code unit `code`, or `"ground"` when `code` ends or rejects the sequence. */
function scanEscape(state: EscapeScan, code: number): EscapeScan | "ground" {
	switch (state) {
		case "esc":
			if (code === 0x5b) return "csi";
			// OSC `]`, DCS `P`, SOS `X`, PM `^` and APC `_` open a string.
			return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f ? "string" : "ground";
		case "csi":
			// Parameter bytes `0x30..=0x3f` and intermediate bytes `0x20..=0x2f` continue it.
			return code >= 0x20 && code <= 0x3f ? "csi" : "ground";
		case "string":
			if (code === 0x07) return "ground";
			return code === 0x1b ? "string-esc" : "string";
		case "string-esc":
			return code === 0x5c ? "ground" : "string";
	}
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
	let state: EscapeScan | "ground" = "ground";
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (state !== "ground") {
			state = scanEscape(state, text.charCodeAt(index));
			continue;
		}
		// Only ESC leaves the ground state, so the scan skips to the next one.
		index = text.indexOf(ESC_CHAR, index);
		if (index === -1) break;
		state = "esc";
		start = index;
	}

	if (state === "ground" || text.length - start > MAX_PARTIAL_ESCAPE) return { head: text, partial: "" };
	return { head: text.slice(0, start), partial: text.slice(start) };
}

/** The characters {@link escapeXmlText} replaces. */
const XML_TEXT_ESCAPABLE = /[&<>]/g;
/** The characters {@link escapeXmlAttribute} replaces. */
const XML_ATTRIBUTE_ESCAPABLE = /[&<>"]/g;
/** What {@link escapeXml} writes for each character it replaces. */
const XML_ENTITIES: Record<number, string> = { 38: "&amp;", 60: "&lt;", 62: "&gt;", 34: "&quot;" };

/**
 * Replace each match of `escapable`, a global pattern of single characters, with its entity. `test`
 * finds the next match without allocating a match array and leaves `lastIndex` just past it; the
 * failing `test` that ends the scan resets `lastIndex` to 0.
 */
function escapeXml(input: string, escapable: RegExp): string {
	escapable.lastIndex = 0;
	if (!escapable.test(input)) return input;
	let output = "";
	// End of the input already copied to `output`.
	let copied = 0;
	do {
		const index = escapable.lastIndex - 1;
		output += input.slice(copied, index) + XML_ENTITIES[input.charCodeAt(index)];
		copied = index + 1;
	} while (escapable.test(input));
	return output + input.slice(copied);
}

/**
 * Escape the three XML-significant characters (`&`, `<`, `>`) in text destined
 * for an XML/markup element body. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Quotes are left as-is
 * — use it for element text, not attribute values.
 */
export function escapeXmlText(input: string): string {
	return escapeXml(input, XML_TEXT_ESCAPABLE);
}

/**
 * Escape XML-significant characters for an attribute VALUE: the three body
 * characters (`&`, `<`, `>`) plus the double quote (`"` → `&quot;`) that would
 * otherwise close the attribute. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Use it for attribute
 * values; {@link escapeXmlText} is for element bodies and leaves `"` intact.
 */
export function escapeXmlAttribute(input: string): string {
	return escapeXml(input, XML_ATTRIBUTE_ESCAPABLE);
}
