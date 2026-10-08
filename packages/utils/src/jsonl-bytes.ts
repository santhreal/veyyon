/**
 * Byte-level JSONL walking, for a complete buffer that is still being appended to.
 *
 * This is the third JSONL reader in the workspace and the only one that never builds a string it
 * does not need. The other two answer different questions:
 *
 * - `parseJsonlLenient` (`./stream.ts`) decodes a COMPLETE buffer, where a trailing partial line is
 *   malformed.
 * - {@link parseJsonlIncremental} (`./jsonl-incremental.ts`) decodes a STREAM arriving in arbitrary
 *   chunks, carrying the partial tail forward as a string.
 * - {@link visitJsonlBytes} here walks a `Uint8Array` whose tail may be a partial line, decoding one
 *   line at a time and returning the offset up to which whole lines were consumed. That offset is the
 *   point of the module: the caller stores it and reads only the new bytes next time, so a file that
 *   grows to hundreds of megabytes is never re-parsed and never fully held as a string.
 *
 * The stats dashboard reads session transcripts this way while the agent is still writing them, which
 * is why a partial tail is the ordinary case here and not an error. Splitting the buffer into strings
 * first would defeat the whole design: the split allocates the entire file again, and the offset the
 * caller needs is a BYTE offset that a string index cannot give back once multi-byte characters are
 * involved.
 *
 * No imports, deliberately, matching `./jsonl-incremental.ts`: a browser bundle must be able to take
 * the walker without pulling in `Bun.JSONL` or SSE parsing.
 */

/** Byte value of `\n`. */
const LF = 0x0a;
/** Byte value of `\r`, trimmed from a line end so CRLF files parse. */
const CR = 0x0d;

/**
 * One shared decoder. `TextDecoder` construction is not free and this runs once per line over files
 * with millions of lines.
 */
const decoder = new TextDecoder();

/** A complete line that did not decode, so whatever it held is missing from the caller's results. */
export interface JsonlByteSkip {
	/** Byte offset of the line's first character, relative to the buffer that was walked. */
	offset: number;
	/** Byte length of the line, so a reader can tell a truncated write from a wrong shape. */
	length: number;
}

export interface VisitJsonlBytesOptions<T> {
	/**
	 * Turn one line's text into an item, or return `undefined` to record a skip.
	 *
	 * Defaults to `JSON.parse` in a `try`. Pass your own when "a line I can use" is narrower than
	 * "valid JSON": a reader expecting objects of a known shape should report a bare `null` line as a
	 * skip rather than visiting it, and only the caller knows that.
	 */
	decode?: (text: string) => T | undefined;
	/**
	 * Called once per malformed complete line, in the order the lines appeared.
	 *
	 * A skip is data loss, and the loss is quantitative and invisible: every total computed from these
	 * items is a sum over the lines that decoded, so a dropped line lowers the answer and the result
	 * still looks complete. Every caller is expected to surface these; the walker reports them rather
	 * than deciding how.
	 *
	 * A BLANK line is not reported. There is no record to lose, and a file being appended to grows a
	 * blank tail constantly.
	 */
	onSkip?: (skip: JsonlByteSkip) => void;
}

/** End of a line's content at or before `end`, past any CR of a CRLF terminator. */
function contentEnd(bytes: Uint8Array, start: number, end: number): number {
	let at = end;
	while (at > start && bytes[at - 1] === CR) at--;
	return at;
}

/**
 * One line's text decoded by `custom`, or parsed as JSON without it. `undefined` when it does not
 * decode, which the caller reports: the offset and length the caller already has are more useful than
 * the parse error.
 */
function decodeText<T>(text: string, custom: ((text: string) => T | undefined) | undefined): T | undefined {
	if (custom) return custom(text);
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/**
 * Decode ONE line of JSONL that a caller already has as bytes, with no newline of its own.
 *
 * For a reader that splits lines somewhere else -- `readLines` over a stream, for instance -- and only
 * needs the same decode {@link visitJsonlBytes} applies: trim a CRLF's CR, then parse. `undefined`
 * when the line is blank or not JSON, which are the same non-answer to "did I get a record".
 *
 * Exported so the CR trim and the parse have ONE owner. Two callers hand-rolling `while (end > start
 * && bytes[end - 1] === CR) end--` is how a reader ends up disagreeing with its own file format.
 */
export function decodeJsonlLine<T = unknown>(
	bytes: Uint8Array,
	options?: { decode?: (text: string) => T | undefined },
): T | undefined {
	const text = decoder.decode(bytes.subarray(0, contentEnd(bytes, 0, bytes.length)));
	if (text.length === 0) return undefined;
	return decodeText(text, options?.decode);
}

/**
 * Walk every COMPLETE line in `bytes`, visiting each decoded item, and return how far to resume.
 *
 * The return value is the byte offset one past the last newline that was consumed. A trailing partial
 * line leaves it before that line, so re-reading from there sees the line whole once it is finished.
 * A buffer that ends exactly on a newline returns its own length.
 *
 * `visit` receives the item and nothing else. A line's offset is reported for a SKIP, where it is the
 * only way to find the bad line, and withheld here because every extra argument is paid once per line
 * over files with millions of them, and no reader has needed it.
 *
 * @example
 * ```ts
 * let offset = 0;
 * // Later, after the file has grown:
 * const bytes = (await Bun.file(path).bytes()).subarray(offset);
 * const read = visitJsonlBytes<Entry>(bytes, entry => rows.push(entry), {
 *   onSkip: skip => logger.warn("dropped a line", { at: offset + skip.offset }),
 * });
 * offset += read;
 * ```
 */
export function visitJsonlBytes<T = unknown>(
	bytes: Uint8Array,
	visit: (item: T) => void,
	options?: VisitJsonlBytesOptions<T>,
): number {
	// Hoisted: which decoder to use and whether anyone is listening for skips are per-WALK facts, and
	// this loop runs once per line over files with millions of them.
	const custom = options?.decode;
	const onSkip = options?.onSkip;
	// Every line before the last newline is complete. The bytes after it are a line still being written
	// or a finished last line with no terminator, and only decoding them tells which.
	const complete = bytes.lastIndexOf(LF) + 1;
	let cursor = 0;

	while (cursor < complete) {
		const start = cursor;
		const newline = bytes.indexOf(LF, start);
		const end = contentEnd(bytes, start, newline);
		cursor = newline + 1;
		// A blank line holds no record: nothing is visited and nothing is lost, so nothing is reported.
		if (end === start) continue;

		// The default parse is written out here rather than reached through `decodeText` or through
		// the same variable as a caller's `decode`. A per-line call to a function holding a `try`, or one
		// polymorphic call site for both, each cost a steady 4-7% on this path against the hand-written
		// loop this replaced (`scripts/bench-jsonl-bytes.ts`).
		const text = decoder.decode(bytes.subarray(start, end));
		let item: T | undefined;
		if (custom === undefined) {
			try {
				item = JSON.parse(text) as T;
			} catch {
				// Not JSON: `item` stays undefined and the line is reported below.
			}
		} else {
			item = custom(text);
		}
		if (item === undefined) {
			// A complete line that could not be used. Skipping keeps the rest of the buffer readable,
			// which is right, but every total downstream is now computed over fewer records than the
			// file holds, and nothing else records that.
			onSkip?.({ offset: start, length: end - start });
		} else {
			visit(item);
		}
	}

	// A tail that does not decode, blank or partial, leaves the offset before it so it is re-read whole
	// once its newline arrives.
	const tailEnd = contentEnd(bytes, complete, bytes.length);
	const tail = tailEnd > complete ? decodeText(decoder.decode(bytes.subarray(complete, tailEnd)), custom) : undefined;
	if (tail === undefined) return complete;
	visit(tail);
	return bytes.length;
}

/** Decoded items from every complete line, plus the offset to resume from. */
export interface JsonlBytesResult<T> {
	items: T[];
	read: number;
}

/**
 * {@link visitJsonlBytes} collected into an array, for a caller that wants the items rather than a
 * streaming visit. Prefer the visitor when the items are only summed or filtered: materializing a
 * whole session's entries is what the byte-level walk exists to avoid.
 */
export function parseJsonlBytes<T = unknown>(
	bytes: Uint8Array,
	options?: VisitJsonlBytesOptions<T>,
): JsonlBytesResult<T> {
	const items: T[] = [];
	const read = visitJsonlBytes<T>(bytes, item => items.push(item), options);
	return { items, read };
}
