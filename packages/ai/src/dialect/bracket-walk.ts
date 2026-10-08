/**
 * Bracket-depth walks over the text of a call whose arguments arrive in a call syntax rather than
 * JSON: Gemini's Python keyword arguments and Gemma's `key:value` pairs. A dialect passes its
 * literal syntax as a {@link SpanSkipper}; a bracket or separator inside a skipped span neither
 * changes the depth nor splits the text.
 */

/**
 * The index just past the span that starts at `i` and that a walk does not look inside, such as a
 * string literal or a comment, or -1 when no such span starts at `i`. A returned index is always
 * greater than `i`.
 */
export type SpanSkipper = (text: string, i: number) => number;

/** The first index of `ch` at or after `from` at bracket depth 0, or -1 when there is none. */
export function topLevelIndexOf(text: string, ch: string, skip: SpanSkipper, from = 0): number {
	let depth = 0;
	let i = from;
	const n = text.length;
	while (i < n) {
		const skipped = skip(text, i);
		if (skipped !== -1) {
			i = skipped;
			continue;
		}
		const c = text[i]!;
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (depth === 0 && c === ch) return i;
		i++;
	}
	return -1;
}

/** `text` split on every `sep` at bracket depth 0. */
export function splitTopLevel(text: string, sep: string, skip: SpanSkipper): string[] {
	const parts: string[] = [];
	let start = 0;
	for (let at = topLevelIndexOf(text, sep, skip); at !== -1; at = topLevelIndexOf(text, sep, skip, start)) {
		parts.push(text.slice(start, at));
		start = at + 1;
	}
	parts.push(text.slice(start));
	return parts;
}

/**
 * The index of the `close` that balances the `open` at `openIndex`, counting only that one bracket
 * pair, or -1 when the text ends first.
 */
export function matchClose(text: string, openIndex: number, open: string, close: string, skip: SpanSkipper): number {
	let depth = 0;
	let i = openIndex;
	const n = text.length;
	while (i < n) {
		const skipped = skip(text, i);
		if (skipped !== -1) {
			i = skipped;
			continue;
		}
		const ch = text[i]!;
		if (ch === open) depth++;
		else if (ch === close && --depth === 0) return i;
		i++;
	}
	return -1;
}
