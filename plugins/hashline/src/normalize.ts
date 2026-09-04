/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 */

export type LineEnding = "\r\n" | "\n";

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface BomResult {
	/** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
	bom: string;
	/** Text with any leading BOM removed. */
	text: string;
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Whether `bytes` begins with the 3-byte UTF-8 BOM (EF BB BF).
 *
 * The canonical byte-level BOM check. A text reader (`Bun.file().text()`,
 * `TextDecoder`) silently consumes a leading BOM, so `stripBom` on decoded text
 * cannot see it; callers that need to round-trip the BOM must detect it from the
 * raw bytes here instead of re-open-coding the sniff.
 */
export function hasUtf8Bom(bytes: Uint8Array | undefined): boolean {
	return bytes !== undefined && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}
