/**
 * What a read's card draws, and how a session file stores it without a second copy of the file.
 *
 * The model reads a file as numbered rows under a snapshot header (`[a.ts#1F2E]`, `12:const x = 1;`)
 * and the card draws the same rows without the numbers, so a result holds the file twice. The
 * session writes the card text only when the result's own text does not rebuild it:
 * {@link readResultCodec} drops it from the written line when a rebuild named by `from` reproduces it
 * exactly and restores it when the session loads, and settles a result the session records into the
 * same rebuilt form, so a running session and a loaded one hold the file once.
 */
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BuiltinToolName } from "../core/builtin-names";
import { type CodedResultContent, firstResultText, MIN_CODED_TEXT } from "../core/output-notice";

/**
 * The file's lines as the card draws them, without the hashline or line-number prefixes the model
 * reads, and the line number each carries. `lineNumbers` is present only when the count from
 * `startLine` breaks (an elided span or a jump between ranges); a contiguous window counts up from
 * `startLine`.
 */
export interface ReadDisplayContent {
	/** Absent in a session file line when `from` rebuilds it from the result's text. */
	text?: string;
	startLine: number;
	lineNumbers?: Array<number | null>;
	/**
	 * How the dropped `text` is rebuilt from the result's first text block. `rows` drops the snapshot
	 * header and each row's `N:`, `N-M:` or `N|` prefix, reading the rows up to the first empty line,
	 * and takes `lineNumbers` from those prefixes. `prefix` is the block's first `length` characters,
	 * with `lineNumbers` stored as the tool returned it.
	 *
	 * A persisted tag. Changing what a rebuild produces is a new tag with the old rebuild kept, or every
	 * session written before the change draws a different card.
	 */
	from?: "rows" | "prefix";
	/** The `prefix` rebuild's length. */
	length?: number;
}

/** A read display with its text present, which is what a card draws. */
export interface ResolvedReadDisplay {
	text: string;
	startLine: number;
	lineNumbers?: Array<number | null>;
}

/** The row that stands for an elided span, drawn as is and numbered by nothing. */
const ELISION_ROW = "…";

const NEWLINE = 0x0a;
const DIGIT_ZERO = 0x30;
const DIGIT_ONE = 0x31;
const DIGIT_NINE = 0x39;
const HYPHEN = 0x2d;
const COLON = 0x3a;
const PIPE = 0x7c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
/** Digits a line number accumulates in exactly; a longer run is parsed as `Number` parses it. */
const EXACT_DIGITS = 15;

/**
 * Each `rows` display {@link rebuild} returned, with the result text it was rebuilt from and the tag it
 * was read from. A result written again while it holds that text writes the tag back without building
 * the card text.
 */
const rebuiltRows = new WeakMap<object, { body: string; tag: ReadDisplayContent }>();

/**
 * Where the run of digits starting at `at` ends, when it is a number with no leading zero; -1 when
 * `at` does not start one. The run stops at the line's newline or the end of the text, since
 * neither is a digit (`charCodeAt` past the end is `NaN`, which no range test admits).
 */
function numberEnd(body: string, at: number): number {
	const first = body.charCodeAt(at);
	if (!(first >= DIGIT_ONE && first <= DIGIT_NINE)) return -1;
	let cursor = at + 1;
	let code = body.charCodeAt(cursor);
	while (code >= DIGIT_ZERO && code <= DIGIT_NINE) code = body.charCodeAt(++cursor);
	return cursor;
}

/**
 * The line numbers of the card rows of numbered result text: the rows after an optional `[…]` header
 * line up to the first empty line, which separates the rows from whatever notice follows. Undefined
 * when a row carries no number prefix, since then the text is not numbered rows. Pushes each row as
 * the card draws it, without its prefix, onto `texts` when given.
 *
 * A row's prefix is `12:`, a merged brace pair's `12-18:`, or line-number mode's `12|`. The rows are
 * scanned in place, so numbering a restored result allocates only the array it returns.
 */
function readRows(body: string, texts?: string[]): Array<number | null> | undefined {
	let start = 0;
	const firstEnd = body.indexOf("\n");
	const firstLineEnd = firstEnd === -1 ? body.length : firstEnd;
	if (body.charCodeAt(0) === OPEN_BRACKET && firstLineEnd > 0 && body.charCodeAt(firstLineEnd - 1) === CLOSE_BRACKET) {
		if (firstEnd === -1) return undefined;
		start = firstEnd + 1;
	}
	const numbers: Array<number | null> = [];
	while (start < body.length && body.charCodeAt(start) !== NEWLINE) {
		let end = body.indexOf("\n", start);
		if (end === -1) end = body.length;
		if (end - start === ELISION_ROW.length && body.startsWith(ELISION_ROW, start)) {
			texts?.push(ELISION_ROW);
			numbers.push(null);
		} else {
			const digitsEnd = numberEnd(body, start);
			if (digitsEnd === -1) return undefined;
			let prefixEnd = digitsEnd;
			if (body.charCodeAt(prefixEnd) === HYPHEN) {
				prefixEnd = numberEnd(body, prefixEnd + 1);
				if (prefixEnd === -1) return undefined;
			}
			// At `end` the character is the newline or past the text, so a prefix that runs to the end of
			// its line has no separator.
			const separator = body.charCodeAt(prefixEnd);
			if (separator !== COLON && separator !== PIPE) return undefined;
			texts?.push(body.slice(prefixEnd + 1, end));
			numbers.push(lineNumber(body, start, digitsEnd));
		}
		start = end + 1;
	}
	return numbers.length > 0 ? numbers : undefined;
}

/** The number the digits `body[start, end)` spell, as `Number` reads them. */
function lineNumber(body: string, start: number, end: number): number {
	if (end - start > EXACT_DIGITS) return Number(body.slice(start, end));
	let value = 0;
	for (let cursor = start; cursor < end; cursor++) value = value * 10 + (body.charCodeAt(cursor) - DIGIT_ZERO);
	return value;
}

/** `numbers` as a display stores them: absent when they count up from `startLine` without a break. */
function storedNumbers(numbers: Array<number | null>, startLine: number): Array<number | null> | undefined {
	for (let i = 0; i < numbers.length; i++) {
		if (numbers[i] !== startLine + i) return numbers;
	}
	return undefined;
}

function sameNumbers(a: readonly (number | null)[] | undefined, b: readonly (number | null)[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The display a written line stores for `display`, or undefined when no rebuild reproduces it. */
function encode(display: ResolvedReadDisplay, body: string): ReadDisplayContent | undefined {
	const { text, startLine, lineNumbers } = display;
	if (text.length < MIN_CODED_TEXT) return undefined;
	const texts: string[] = [];
	const numbers = readRows(body, texts);
	if (
		numbers !== undefined &&
		sameNumbers(storedNumbers(numbers, startLine), lineNumbers) &&
		texts.join("\n") === text
	) {
		return { startLine, from: "rows" };
	}
	if (body.startsWith(text)) {
		return { startLine, ...(lineNumbers === undefined ? {} : { lineNumbers }), from: "prefix", length: text.length };
	}
	return undefined;
}

/**
 * A `rows` display over `body`, the result text tagged `tag`, numbered by `lineNumbers`. Its text is
 * built on first read, so a transcript that draws no read preview holds no second copy of the files it
 * read.
 */
function rowsDisplay(
	body: string,
	tag: ReadDisplayContent,
	lineNumbers: Array<number | null> | undefined,
): ResolvedReadDisplay {
	// The result text the rows are read from, until the card text is built from it. A prune that
	// replaces the result's content leaves this display the only holder of that text, so the getter
	// releases it once the card text exists.
	let rows: string | undefined = body;
	let text = "";
	const display: ResolvedReadDisplay = {
		get text() {
			if (rows !== undefined) {
				const texts: string[] = [];
				readRows(rows, texts);
				text = texts.join("\n");
				rows = undefined;
			}
			return text;
		},
		startLine: tag.startLine,
		...(lineNumbers === undefined ? {} : { lineNumbers }),
	};
	rebuiltRows.set(display, { body, tag });
	return display;
}

/** The display `from` names, rebuilt from the result's text; undefined when that text cannot rebuild it. */
function rebuild(display: ReadDisplayContent, content: CodedResultContent): ResolvedReadDisplay | undefined {
	const body = firstResultText(content);
	if (body === undefined) return undefined;
	const { startLine } = display;
	if (display.from === "rows") {
		const numbers = readRows(body);
		return numbers === undefined ? undefined : rowsDisplay(body, display, storedNumbers(numbers, startLine));
	}
	if (display.from === "prefix" && typeof display.length === "number" && display.length <= body.length) {
		const text = body.slice(0, display.length);
		return { text, startLine, ...(display.lineNumbers === undefined ? {} : { lineNumbers: display.lineNumbers }) };
	}
	return undefined;
}

function isWholeDisplay(value: unknown): value is ResolvedReadDisplay {
	return isRecord(value) && typeof value.text === "string" && typeof value.startLine === "number";
}

function isSlimDisplay(value: unknown): value is ReadDisplayContent {
	return isRecord(value) && typeof value.from === "string" && value.text === undefined;
}

/** How a read result is written to a session file and read back. */
export const readResultCodec: ToolResultCodec = {
	toolName: "read" satisfies BuiltinToolName,
	slim(details, content) {
		if (!isRecord(details) || !isRecord(details.displayContent)) return details;
		const body = firstResultText(content);
		if (body === undefined) return details;
		const loaded = rebuiltRows.get(details.displayContent);
		if (loaded !== undefined) {
			if (loaded.body === body) return { ...details, displayContent: loaded.tag };
			// The content no longer holds the text the display was rebuilt from (a prune replaced it), so
			// the tag is never written again and the entry would hold that text for nothing.
			rebuiltRows.delete(details.displayContent);
		}
		if (!isWholeDisplay(details.displayContent)) return details;
		const displayContent = encode(details.displayContent, body);
		return displayContent === undefined ? details : { ...details, displayContent };
	},
	restore(details, content) {
		if (!isRecord(details) || !isSlimDisplay(details.displayContent)) return;
		const rebuilt = rebuild(details.displayContent, content);
		if (rebuilt !== undefined) details.displayContent = rebuilt;
	},
	// A recorded read holds its card text as a load rebuilds it: a `rows` card is built from the
	// result's text on first draw, which the terminal's grouped reads never do, and a `prefix` card is
	// a slice of that text, so the entry holds the file once.
	settle(details, content) {
		// A display rebuilt by an earlier pass is checked first: reading `text` off it builds the card.
		if (!isRecord(details) || !isRecord(details.displayContent) || rebuiltRows.has(details.displayContent)) return;
		const display = details.displayContent;
		if (!isWholeDisplay(display)) return;
		const body = firstResultText(content);
		if (body === undefined) return;
		const tag = encode(display, body);
		if (tag === undefined) return;
		// `encode` checked that the rows number the text as `display.lineNumbers` does.
		details.displayContent =
			tag.from === "rows" ? rowsDisplay(body, tag, display.lineNumbers) : (rebuild(tag, content) ?? display);
	},
};

/**
 * The display a card draws for a read result. A session loaded with the codec registered holds it
 * whole; a transcript read without that restore holds the written form, which is rebuilt here from
 * the result's text. Undefined when the result has no display or its text no longer rebuilds one.
 */
export function resolveReadDisplay(
	display: ReadDisplayContent | undefined,
	content: CodedResultContent,
): ResolvedReadDisplay | undefined {
	if (display === undefined) return undefined;
	if ("text" in display) return display as ResolvedReadDisplay;
	return rebuild(display, content);
}
