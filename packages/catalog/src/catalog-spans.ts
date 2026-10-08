/**
 * Where each provider's object, and each model's object inside it, sits in `models.json`, found
 * without parsing the document.
 *
 * The generator writes the catalog as `JSON.stringify(models, null, "\t")`. In that layout a
 * provider's key is the only line that starts with exactly one tab and a quote, and the provider's
 * closing brace is the first line after it that is exactly one tab and `}`: every line inside a
 * provider starts with at least two tabs, and a JSON string holds no raw newline. A model is the same
 * shape one level deeper, two tabs. One `indexOf` per object finds its brace, so a reader parses the
 * provider or the model it needs rather than the whole catalog.
 */

/** The byte range `[start, end)` of one provider's object, braces included. */
export interface CatalogSpan {
	readonly start: number;
	readonly end: number;
}

const NEWLINE = 0x0a;
const TAB = 0x09;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const SPACE = 0x20;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const PROVIDER_CLOSE_LINE = "\n\t}";
const MODEL_CLOSE_LINE = "\n\t\t}";
/** A key JSON.parse moves ahead of every other key of its object: a canonical array index. */
const ARRAY_INDEX_KEY = /^(?:0|[1-9][0-9]*)$/;

/**
 * Every bundled model's key and the byte range `[start, end)` of its object, braces included, in the
 * order a whole-document parse enumerates them: providers in `spans` order, models in document order.
 * Parallel arrays, one slot per model.
 */
export interface CatalogModelSpans {
	readonly ids: readonly string[];
	readonly starts: readonly number[];
	readonly ends: readonly number[];
}

/**
 * The span of every provider's object in `bytes`, in document order, or `null` when `bytes` is not
 * in the generator's layout. A `null` index sends every read through a parse of the whole document.
 */
export function indexCatalogSpans(bytes: Buffer): Map<string, CatalogSpan> | null {
	const spans = new Map<string, CatalogSpan>();
	if (bytes[0] !== OPEN_BRACE) return null;
	if (bytes[1] === CLOSE_BRACE) return isDocumentEnd(bytes, 2) ? spans : null;
	// `line` is the offset of the newline that opens a provider's key line.
	let line = 1;
	for (;;) {
		if (bytes[line] !== NEWLINE || bytes[line + 1] !== TAB || bytes[line + 2] !== QUOTE) return null;
		const keyStart = line + 2;
		const keyEnd = closingQuote(bytes, keyStart + 1);
		if (keyEnd < 0) return null;
		if (bytes[keyEnd + 1] !== COLON || bytes[keyEnd + 2] !== SPACE || bytes[keyEnd + 3] !== OPEN_BRACE) return null;
		const key = JSON.parse(bytes.toString("utf8", keyStart, keyEnd + 1)) as string;
		const start = keyEnd + 3;
		let end: number;
		if (bytes[start + 1] === CLOSE_BRACE) {
			end = start + 2;
		} else if (bytes[start + 1] === NEWLINE) {
			const close = bytes.indexOf(PROVIDER_CLOSE_LINE, start);
			if (close < 0) return null;
			end = close + PROVIDER_CLOSE_LINE.length;
		} else {
			return null;
		}
		// The whole-document parse keeps the last of two equal keys; a span index would keep the first.
		if (spans.has(key)) return null;
		spans.set(key, { start, end });
		if (bytes[end] === COMMA) {
			line = end + 1;
			continue;
		}
		return bytes[end] === NEWLINE && bytes[end + 1] === CLOSE_BRACE && isDocumentEnd(bytes, end + 2) ? spans : null;
	}
}

/**
 * The key and span of every model in the providers of `spans`, or `null` when a provider is not in the
 * generator's layout or its enumeration order would differ from a parse of the document: a repeated
 * model key (the parse keeps the last) or a key that is an array index (the parse moves it first).
 * The same holds for a provider key, so `null` also covers an array-index provider.
 */
export function indexCatalogModelSpans(
	bytes: Buffer,
	spans: ReadonlyMap<string, CatalogSpan>,
): CatalogModelSpans | null {
	const ids: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	const seen = new Set<string>();
	for (const [provider, span] of spans) {
		if (ARRAY_INDEX_KEY.test(provider)) return null;
		if (bytes[span.start + 1] === CLOSE_BRACE) continue;
		seen.clear();
		// `line` is the offset of the newline that opens a model's key line.
		let line = span.start + 1;
		for (;;) {
			if (
				bytes[line] !== NEWLINE ||
				bytes[line + 1] !== TAB ||
				bytes[line + 2] !== TAB ||
				bytes[line + 3] !== QUOTE
			) {
				return null;
			}
			const keyStart = line + 3;
			const keyEnd = closingQuote(bytes, keyStart + 1);
			if (keyEnd < 0) return null;
			if (bytes[keyEnd + 1] !== COLON || bytes[keyEnd + 2] !== SPACE || bytes[keyEnd + 3] !== OPEN_BRACE)
				return null;
			const id = keyText(bytes, keyStart, keyEnd);
			if (seen.has(id) || ARRAY_INDEX_KEY.test(id)) return null;
			seen.add(id);
			const start = keyEnd + 3;
			let end: number;
			if (bytes[start + 1] === CLOSE_BRACE) {
				end = start + 2;
			} else if (bytes[start + 1] === NEWLINE) {
				const close = bytes.indexOf(MODEL_CLOSE_LINE, start);
				if (close < 0) return null;
				end = close + MODEL_CLOSE_LINE.length;
			} else {
				return null;
			}
			ids.push(id);
			starts.push(start);
			ends.push(end);
			if (bytes[end] === COMMA) {
				line = end + 1;
				continue;
			}
			if (
				end + PROVIDER_CLOSE_LINE.length !== span.end ||
				bytes.toString("latin1", end, span.end) !== PROVIDER_CLOSE_LINE
			) {
				return null;
			}
			break;
		}
	}
	return { ids, starts, ends };
}

/** The string the JSON key literal `[quote, closing]` decodes to, read without a parse when it holds no escape. */
function keyText(bytes: Buffer, quote: number, closing: number): string {
	for (let i = quote + 1; i < closing; i++) {
		if (bytes[i] === BACKSLASH) return JSON.parse(bytes.toString("utf8", quote, closing + 1)) as string;
	}
	return bytes.toString("utf8", quote + 1, closing);
}

/** The offset of the quote that closes the JSON string whose body starts at `from`, or -1. */
function closingQuote(bytes: Buffer, from: number): number {
	for (let i = from; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === BACKSLASH) i++;
		else if (byte === QUOTE) return i;
		else if (byte === NEWLINE) return -1;
	}
	return -1;
}

/** Whether nothing but one optional trailing newline follows `offset`. */
function isDocumentEnd(bytes: Buffer, offset: number): boolean {
	return offset === bytes.length || (offset + 1 === bytes.length && bytes[offset] === NEWLINE);
}
