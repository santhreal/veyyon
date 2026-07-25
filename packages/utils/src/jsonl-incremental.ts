/**
 * Incremental JSONL decoding for streamed transcripts, and the one owner of the
 * "a malformed record was skipped" report shared with `parseJsonlLenient`.
 *
 * Two JSONL readers exist because they answer different questions.
 * {@link parseJsonlIncremental} decodes a stream that arrives in arbitrary
 * chunks, so a trailing partial line is not an error: it is returned as `carry`
 * and prepended to the next chunk. `parseJsonlLenient` in `./stream.ts` decodes
 * a COMPLETE buffer, where a trailing partial line IS malformed. They share
 * {@link JsonlSkip}, defined here rather than there, so both report a dropped
 * record in one shape.
 *
 * This module deliberately has no imports. `./stream.ts` reaches for
 * `Bun.JSONL` and pulls in SSE parsing; browser bundles (collab-web polls a
 * host's transcript in the same carry-and-append pattern) must be able to take
 * the parser without any of that.
 */

/** A malformed JSONL record that lenient parsing skipped. */
export interface JsonlSkip {
	/** Character offset into the buffer where the bad record began. */
	offset: number;
	/** The skipped line, so callers can log or surface what was dropped. */
	snippet: string;
}

/** Longest snippet reported for a skipped record, so one huge bad line cannot
 *  flood a log or a UI notice. Matches `parseJsonlLenient`'s cap. */
const SNIPPET_MAX = 200;

export interface ParseJsonlIncrementalOptions {
	/**
	 * Called once per malformed complete line, in the order the lines appeared.
	 *
	 * A skip is data loss. Dropping a transcript row silently means the reader
	 * shows a transcript with a hole in it and nothing anywhere says so, which is
	 * indistinguishable from the agent never having said that. Every caller is
	 * expected to surface these; `parseJsonlIncremental` reports them rather than
	 * deciding how.
	 */
	onSkip?: (skip: JsonlSkip) => void;
}

/** Parsed records from the complete lines of a chunk, plus the partial tail. */
export interface JsonlIncrementalResult<T> {
	items: T[];
	/**
	 * The trailing partial line, to be passed back as `carry` with the next
	 * chunk. Empty when the chunk ended exactly on a newline.
	 */
	carry: string;
}

/**
 * Decode one chunk of a JSONL stream, carrying the incomplete tail forward.
 *
 * `carry` is the previous call's `carry` (`""` on the first call). Complete
 * lines are parsed; blank lines are ignored; a complete line that is not valid
 * JSON is skipped and reported through `onSkip`.
 *
 * @example
 * ```ts
 * let carry = "";
 * for await (const chunk of chunks) {
 *   const { items, carry: next } = parseJsonlIncremental(chunk, carry, {
 *     onSkip: skip => console.warn(`dropped a record at ${skip.offset}: ${skip.snippet}`),
 *   });
 *   carry = next;
 *   handle(items);
 * }
 * ```
 */
export function parseJsonlIncremental<T = unknown>(
	text: string,
	carry: string,
	options?: ParseJsonlIncrementalOptions,
): JsonlIncrementalResult<T> {
	const buffer = carry + text;
	const lines = buffer.split("\n");
	// The last element is whatever followed the final newline: either an
	// incomplete record still being written, or "" when the chunk ended on a
	// newline. Never parsed here — that is what makes this incremental.
	const nextCarry = lines.pop() ?? "";
	const items: T[] = [];
	// Offsets are relative to `carry + text`, i.e. the record's own start, so a
	// report points at the record and not at wherever this chunk happened to be
	// cut.
	let offset = 0;
	for (const line of lines) {
		const start = offset;
		offset += line.length + 1;
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			items.push(JSON.parse(trimmed) as T);
		} catch {
			options?.onSkip?.({ offset: start, snippet: trimmed.slice(0, SNIPPET_MAX) });
		}
	}
	return { items, carry: nextCarry };
}
