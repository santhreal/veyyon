import { setSafeProperty } from "./type-guards";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const U = 0x75;
const SQUOTE = 0x27;

// Valid chars after `\`: " \ / b f n r t u
const VALID_ESCAPE_CHAR = new Uint8Array(128);
for (const ch of '"\\/bfnrtu') VALID_ESCAPE_CHAR[ch.charCodeAt(0)] = 1;

const CONTROL_ESCAPES: readonly string[] = (() => {
	const e: string[] = [];
	e[0x08] = "\\b";
	e[0x09] = "\\t";
	e[0x0a] = "\\n";
	e[0x0c] = "\\f";
	e[0x0d] = "\\r";
	for (let cp = 0; cp <= 0x1f; cp++) {
		e[cp] ??= `\\u${cp.toString(16).padStart(4, "0")}`;
	}
	return e;
})();

const HEX4_RE = /^[0-9a-fA-F]{4}$/;

/** What each single-character escape a relaxed string accepts decodes to, by its character; `\u` is decoded apart. */
const SIMPLE_ESCAPES: Record<string, string> = {
	'"': '"',
	"'": "'",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

function isHexDigit(cp: number): boolean {
	return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
}

function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function isIdentChar(cp: number): boolean {
	return (
		(cp >= 0x30 && cp <= 0x39) ||
		((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a) ||
		cp === 0x5f /* _ */ ||
		cp === 0x24 /* $ */
	);
}

/** Bareword literals: standard JSON plus Python `True`/`False`/`None`. */
const KEYWORDS: readonly (readonly [string, unknown])[] = [
	["true", true],
	["false", false],
	["null", null],
	["True", true],
	["False", false],
	["None", null],
];

/**
 * JS-only atoms never recovered as bareword strings — a tool must not execute
 * with a non-finite or undefined argument masquerading as a string.
 */
const NON_RECOVERABLE_BAREWORDS: Record<string, true> = {
	NaN: true,
	Infinity: true,
	"-Infinity": true,
	"+Infinity": true,
	undefined: true,
};

/**
 * Sentinel returned by partial-mode value parsing when an atomic value
 * (number / keyword) is incomplete at the streaming edge, so the enclosing
 * object/array rolls back to the last valid prefix instead of committing junk.
 */
const INCOMPLETE = Symbol("incomplete");

/**
 * Length of the valid JSON escape starting at the backslash at `i`, or 0 when the backslash starts none,
 * a backslash at the end of input included.
 */
function validEscapeLength(json: string, i: number): number {
	if (i + 1 >= json.length) return 0;
	const next = json.charCodeAt(i + 1);
	if (next !== U) return next < 128 && VALID_ESCAPE_CHAR[next] === 1 ? 2 : 0;
	return isHexDigit(json.charCodeAt(i + 2)) &&
		isHexDigit(json.charCodeAt(i + 3)) &&
		isHexDigit(json.charCodeAt(i + 4)) &&
		isHexDigit(json.charCodeAt(i + 5))
		? 6
		: 0;
}

/**
 * Index of the next code unit `repairJson` rewrites, at or after `i`, which is inside a string: a raw
 * control character, or a backslash that starts no valid escape. Valid escapes and the text between
 * strings are skipped. Returns `json.length` when no such code unit remains.
 */
function nextRepairAt(json: string, i: number): number {
	const len = json.length;
	while (i < len) {
		const cp = json.charCodeAt(i);
		if (cp === QUOTE) {
			// The string closes: skip to the first code unit of the next one.
			i++;
			while (i < len && json.charCodeAt(i) !== QUOTE) i++;
			i++;
		} else if (cp === BACKSLASH) {
			const escapeLength = validEscapeLength(json, i);
			if (escapeLength === 0) return i;
			i += escapeLength;
		} else if (cp < 0x20) {
			return i;
		} else {
			i++;
		}
	}
	return len;
}

/**
 * Lightweight string-level repair of the escape/control-char hazards that make
 * otherwise-valid JSON fail `JSON.parse`: raw control characters inside strings
 * are escaped, and invalid `\x` escapes have their backslash escaped. Returns the
 * input unchanged when no repair is needed. Pure string→string; does not parse.
 */
export function repairJson(json: string): string {
	const first = json.indexOf('"');
	if (first === -1) return json;
	const len = json.length;
	const parts: string[] = [];
	let lastEmit = 0;
	let i = nextRepairAt(json, first + 1);
	while (i < len) {
		const cp = json.charCodeAt(i);
		parts.push(json.slice(lastEmit, i), cp === BACKSLASH ? "\\\\" : CONTROL_ESCAPES[cp]);
		lastEmit = i + 1;
		i = nextRepairAt(json, lastEmit);
	}
	if (!parts.length) return json;
	if (lastEmit < len) parts.push(json.slice(lastEmit));
	return parts.join("");
}

/**
 * Index just past the `//` comment (its newline excluded) or block comment that starts at the `/` at `i`,
 * the end of `s` when the comment is unterminated, or `i` when that `/` starts no comment.
 */
function commentEnd(s: string, i: number): number {
	const n = s.length;
	const next = s.charCodeAt(i + 1);
	let k = i + 2;
	if (next === 0x2f /* / line comment */) {
		while (k < n && s.charCodeAt(k) !== 0x0a) k++;
		return k;
	}
	if (next !== 0x2a /* * block comment */) return i;
	while (k + 1 < n && !(s.charCodeAt(k) === 0x2a && s.charCodeAt(k + 1) === 0x2f)) k++;
	return Math.min(k + 2, n);
}

/**
 * Recursive-descent parser for a forgiving superset of JSON. Beyond strict JSON
 * it accepts, and normalizes, the malformations LLM tool-call bodies leak in
 * practice:
 *
 * - single-quoted strings and unquoted object keys (JSON5);
 * - trailing / stray commas, and `//` + block comments;
 * - Python literals `True` / `False` / `None` and JS `NaN` / `Infinity`;
 * - raw control characters and invalid `\x` escapes inside strings (kept literally);
 * - unescaped quotes inside strings — a quote only closes a string when followed
 *   by a value terminator, recovering apostrophes such as `'it's'`;
 * - unquoted string values in object/array value position (strict mode only) —
 *   an unrecognized bareword such as `{"paths": packages/foo/*}` is recovered as
 *   a string up to the next `,` / `}` / `]` / newline.
 *
 * In `partial` mode an unterminated string/object/array (or a value cut off at
 * end-of-input) is auto-closed with whatever was parsed so far — for streaming.
 * In strict mode, end-of-input mid-value and trailing garbage both throw, so a
 * final parse never silently accepts a half-formed tool call.
 */
class RelaxedJson {
	readonly #s: string;
	readonly #n: number;
	readonly #partial: boolean;
	#i = 0;

	constructor(source: string, partial: boolean) {
		this.#s = source;
		this.#n = source.length;
		this.#partial = partial;
	}

	parse(): unknown {
		this.#ws();
		if (this.#i >= this.#n) {
			if (this.#partial) return undefined;
			throw new SyntaxError("Unexpected end of JSON input");
		}
		const value = this.#value(false);
		if (value === INCOMPLETE) return undefined;
		this.#ws();
		if (!this.#partial && this.#i < this.#n) {
			throw new SyntaxError(`Unexpected trailing characters at position ${this.#i}`);
		}
		return value;
	}

	#ws(): void {
		const s = this.#s;
		for (;;) {
			while (this.#i < this.#n && isWhitespace(s.charCodeAt(this.#i))) this.#i++;
			if (this.#i + 1 >= this.#n || s.charCodeAt(this.#i) !== 0x2f /* / */) return;
			const end = commentEnd(s, this.#i);
			if (end === this.#i) return;
			this.#i = end;
		}
	}

	#value(allowBareword: boolean): unknown {
		const s = this.#s;
		const c = s[this.#i];
		if (c === "{") return this.#object();
		if (c === "[") return this.#array();
		if (c === '"' || c === "'") return this.#string(s.charCodeAt(this.#i));
		const cc = s.charCodeAt(this.#i);
		if (cc === 0x2d /* - */ || cc === 0x2b /* + */ || cc === 0x2e /* . */ || (cc >= 0x30 && cc <= 0x39)) {
			// JS-only NaN / Infinity are deliberately not accepted: a tool must not
			// execute with a non-finite numeric arg; they fall through #number's
			// NaN guard (strict throw / partial rollback) like other bad tokens.
			return this.#number();
		}
		return this.#keyword(allowBareword);
	}

	#object(): Record<string, unknown> {
		this.#i++; // consume {
		const out: Record<string, unknown> = {};
		for (;;) {
			if (!this.#containerHasElement("}", "Unterminated object")) return out;
			const key = this.#key();
			this.#ws();
			if (this.#i < this.#n && this.#s[this.#i] === ":") {
				this.#i++;
			} else if (this.#partial) {
				return out;
			} else {
				throw new SyntaxError("Expected ':' in object");
			}
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return out;
				throw new SyntaxError("Expected value after ':'");
			}
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			// Match native JSON.parse: a literal `__proto__` (or constructor/prototype)
			// key must become an own data property, not mutate the object's prototype
			// or be dropped. This relaxed parser runs on malformed/truncated input
			// (e.g. a truncated streaming tool-call buffer) where such a key can appear.
			setSafeProperty(out, key, value);
			if (!this.#containerContinues("}", "Expected ',' or '}' in object")) return out;
		}
	}

	#array(): unknown[] {
		this.#i++; // consume [
		const out: unknown[] = [];
		for (;;) {
			if (!this.#containerHasElement("]", "Unterminated array")) return out;
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			out.push(value);
			if (!this.#containerContinues("]", "Expected ',' or ']' in array")) return out;
		}
	}

	/**
	 * Positions the cursor on the next element of an object or array, skipping
	 * whitespace and leading, doubled or trailing commas. Returns false once
	 * `closer` (consumed) or, in partial mode, end of input ends the container;
	 * in strict mode end of input throws `unterminated`.
	 */
	#containerHasElement(closer: string, unterminated: string): boolean {
		for (;;) {
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return false;
				throw new SyntaxError(unterminated);
			}
			const c = this.#s[this.#i];
			if (c === closer) {
				this.#i++;
				return false;
			}
			if (c === ",") {
				this.#i++;
				continue;
			}
			return true;
		}
	}

	/**
	 * Consumes what follows an element. Returns true after a comma, false once
	 * `closer` (consumed) or, in partial mode, anything else ends the container;
	 * in strict mode anything else throws `expected`.
	 */
	#containerContinues(closer: string, expected: string): boolean {
		this.#ws();
		const d = this.#i < this.#n ? this.#s[this.#i] : "";
		if (d === ",") {
			this.#i++;
			return true;
		}
		if (d === closer) {
			this.#i++;
			return false;
		}
		if (this.#partial) return false;
		throw new SyntaxError(expected);
	}

	#key(): string {
		const c = this.#s[this.#i];
		if (c === '"' || c === "'") return this.#string(this.#s.charCodeAt(this.#i));
		// Unquoted identifier key: read until a structural delimiter / whitespace.
		const start = this.#i;
		while (this.#i < this.#n) {
			const ch = this.#s[this.#i];
			if (ch === ":" || ch === "," || ch === "}" || isWhitespace(this.#s.charCodeAt(this.#i))) break;
			this.#i++;
		}
		if (this.#i === start) {
			if (this.#partial) return "";
			throw new SyntaxError("Expected object key");
		}
		return this.#s.slice(start, this.#i);
	}

	#string(quote: number): string {
		const s = this.#s;
		const n = this.#n;
		let i = this.#i + 1; // skip opening quote
		let out = "";
		let runStart = i;
		while (i < n) {
			const cc = s.charCodeAt(i);
			if (cc !== BACKSLASH && cc !== quote) {
				i++;
			} else if (cc === BACKSLASH) {
				out += s.slice(runStart, i);
				out += this.#escape(i + 1);
				i = runStart = this.#i;
			} else if (this.#closesString(quote, i + 1)) {
				out += s.slice(runStart, i);
				this.#i = i + 1;
				return out;
			} else {
				// Unescaped inner quote (e.g. apostrophe in `'it's'`) — keep it literal.
				i++;
			}
		}
		out += s.slice(runStart, i);
		if (this.#partial) {
			this.#i = i;
			return out;
		}
		throw new SyntaxError("Unterminated string");
	}

	/**
	 * Decodes the escape whose character is at `at`, one past a backslash, and leaves the cursor after it.
	 * An invalid escape, a `\u` without four hex digits among them, keeps its backslash literally, and a
	 * backslash at the end of input decodes to itself.
	 */
	#escape(at: number): string {
		const s = this.#s;
		this.#i = Math.min(at + 1, this.#n);
		if (at >= this.#n) return "\\";
		const ch = s[at];
		const simple = SIMPLE_ESCAPES[ch];
		if (simple !== undefined) return simple;
		const hex = ch === "u" ? s.slice(at + 1, at + 5) : "";
		if (!HEX4_RE.test(hex)) return `\\${ch}`;
		this.#i = at + 5;
		return String.fromCharCode(parseInt(hex, 16));
	}

	/**
	 * Whether a `quote` character closes the string it is in. A double quote in strict mode always does,
	 * like standard JSON, so malformed structure fails instead of swallowing commas and colons into one
	 * string. A single quote, or any quote in partial mode, closes it only when the next non-space
	 * character after it, at `from`, ends a value; otherwise it is an inner quote such as an apostrophe.
	 */
	#closesString(quote: number, from: number): boolean {
		if (quote !== SQUOTE && !this.#partial) return true;
		const s = this.#s;
		let k = from;
		while (k < this.#n && isWhitespace(s.charCodeAt(k))) k++;
		if (k >= this.#n) return true;
		const c = s[k];
		return c === "," || c === "}" || c === "]" || c === ":";
	}

	#number(): unknown {
		const s = this.#s;
		const start = this.#i;
		while (this.#i < this.#n) {
			const ch = s[this.#i];
			if (
				(ch >= "0" && ch <= "9") ||
				ch === "-" ||
				ch === "+" ||
				ch === "." ||
				ch === "e" ||
				ch === "E" ||
				ch === "x" ||
				ch === "X" ||
				(ch >= "a" && ch <= "f") ||
				(ch >= "A" && ch <= "F")
			) {
				this.#i++;
			} else {
				break;
			}
		}
		const token = s.slice(start, this.#i);
		const num = Number(token);
		if (Number.isNaN(num)) {
			if (this.#partial) return INCOMPLETE;
			throw new SyntaxError(`Invalid number: ${token}`);
		}
		return num;
	}

	#keyword(allowBareword: boolean): unknown {
		const s = this.#s;
		const i = this.#i;
		for (const [word, value] of KEYWORDS) {
			// Require a non-identifier boundary so `Truex` / `nullish` are not misread
			// as the keyword followed by junk.
			if (s.startsWith(word, i) && !isIdentChar(s.charCodeAt(i + word.length))) {
				this.#i += word.length;
				return value;
			}
		}
		if (this.#partial) {
			// Incomplete / unrecognized atomic token at the streaming edge — signal the
			// caller to roll back to the last valid prefix instead of committing junk.
			this.#i = this.#n;
			return INCOMPLETE;
		}
		if (allowBareword) return this.#bareword();
		throw new SyntaxError(`Unexpected token at position ${this.#i}`);
	}

	/**
	 * Strict-mode recovery of an unquoted string value, e.g.
	 * `{"paths": packages/foo/*}`: consume until `,` / `}` / `]` / newline and
	 * trim trailing whitespace. Recovery still throws — so a final parse never
	 * accepts a half-formed or non-finite argument — when the token:
	 * - hits end-of-input before a delimiter (truncated value);
	 * - contains a `"`, `{`, `[`, or a key-like `:` — this parser accepts
	 *   unquoted keys, so a missed comma (`{"a": foo "b": 1}`, `{a: foo b: 1}`)
	 *   would otherwise silently swallow the following field. A colon followed
	 *   by `/` or `\` stays literal so URL and Windows-path values recover;
	 * - is a non-finite atom ({@link NON_RECOVERABLE_BAREWORDS}).
	 */
	#bareword(): string {
		const s = this.#s;
		const start = this.#i;
		let i = start;
		while (i < this.#n) {
			const cc = s.charCodeAt(i);
			if (cc === 0x2c /* , */ || cc === 0x7d /* } */ || cc === 0x5d /* ] */ || cc === 0x0a || cc === 0x0d) break;
			if (
				cc === QUOTE ||
				cc === 0x7b /* { */ ||
				cc === 0x5b /* [ */ ||
				(cc === 0x3a /* : */ && s.charCodeAt(i + 1) !== 0x2f /* / */ && s.charCodeAt(i + 1) !== 0x5c) /* \ */
			) {
				throw new SyntaxError(`Unexpected token at position ${start}`);
			}
			i++;
		}
		if (i >= this.#n) throw new SyntaxError(`Unexpected token at position ${start}`);
		let end = i;
		while (end > start && isWhitespace(s.charCodeAt(end - 1))) end--;
		const word = s.slice(start, end);
		// Object.hasOwn, not `NON_RECOVERABLE_BAREWORDS[word]`: a bare index read
		// resolves Object.prototype members, so an unquoted value literally named
		// `constructor` (and, before NFKC/casing, `toString`/`valueOf`/
		// `hasOwnProperty`) would read the inherited method (truthy) and be thrown
		// as non-recoverable instead of recovered as the string it is. Only the
		// five curated non-finite/undefined atoms may abort recovery.
		if (Object.hasOwn(NON_RECOVERABLE_BAREWORDS, word))
			throw new SyntaxError(`Unexpected token at position ${start}`);
		this.#i = i;
		return word;
	}
}

/**
 * Final-parse a JSON value, repairing the common LLM malformations
 * ({@link RelaxedJson}). Tries strict `JSON.parse` first (fast path, exact JSON
 * semantics), then the relaxed parser. Throws when the input is unrepairable,
 * truncated, or carries trailing garbage — so callers can skip a bad tool call
 * rather than execute a half-formed one.
 */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return new RelaxedJson(json, false).parse() as T;
	}
}

/**
 * Parse possibly-incomplete JSON during streaming. Always returns a value, never
 * throws: `{}` for empty/whitespace/unrecoverable buffers, and an auto-closed
 * best-effort object for truncated ones.
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	const trimmed = partialJson?.trimStart();
	if (!trimmed) return {} as T;
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		try {
			return (new RelaxedJson(trimmed, true).parse() ?? {}) as T;
		} catch {
			return {} as T;
		}
	}
}

/**
 * Default minimum byte growth before `parseStreamingJsonThrottled` will
 * re-parse a streaming tool-call argument buffer. Bounds the mid-stream
 * partial-parse cost from quadratic to linear in N.
 */
export const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

/**
 * Throttled variant of {@link parseStreamingJson} for the per-delta hot path.
 *
 * Tool calls arrive as a long sequence of small deltas — calling
 * `parseStreamingJson(buffer)` on every delta re-parses the entire buffer
 * each time, giving O(N²) work in the total buffer length. Throttling skips
 * the re-parse until at least `minGrowthBytes` of new content has arrived
 * since the last successful parse, bounding mid-stream cost to O(N).
 *
 * Each provider tracks the last parsed length on its tool-call block, so the
 * final `toolcall_end` parse (which providers already perform unconditionally)
 * is the authoritative full parse — the throttle only delays mid-stream UI
 * updates by at most `minGrowthBytes` of accumulated partial content.
 *
 * @returns the parsed object plus the new `parsedLen` to persist; or `null`
 *          when the buffer has not grown enough to warrant a re-parse.
 */
export function parseStreamingJsonThrottled<T = Record<string, unknown>>(
	partialJson: string | undefined,
	lastParsedLen: number,
	minGrowthBytes: number = STREAMING_JSON_PARSE_MIN_GROWTH,
): { value: T; parsedLen: number } | null {
	const len = partialJson?.length ?? 0;
	if (len === 0 || (lastParsedLen > 0 && len - lastParsedLen < minGrowthBytes)) return null;
	return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}

/**
 * Classification of a streaming buffer against strict JSON (RFC 8259):
 * - `"complete"`: exactly one whole JSON value (plus surrounding whitespace).
 * - `"prefix"`: a proper prefix of some valid JSON value — more bytes can
 *   still complete it.
 * - `"invalid"`: no suffix can ever make it valid strict JSON (e.g. a raw
 *   control character inside a string, or a second top-level value).
 */
export type JsonPrefixState = "complete" | "prefix" | "invalid";

/** What the strict-prefix scanner expects at the current position. */
const enum JsonExpect {
	Value,
	ObjKeyOrEnd,
	ObjKey,
	ObjColon,
	ObjCommaOrEnd,
	ArrValueOrEnd,
	ArrCommaOrEnd,
	End,
}

/**
 * Classify `text` as a strict-JSON value, prefix, or dead end.
 *
 * Providers use this to disambiguate identifierless streaming tool-call
 * deltas: a chunk starting with `{` is a *new* sibling call only if the
 * current call's argument buffer cannot absorb it — the buffer is already a
 * complete value, already unsalvageable (lossy hosts abandon buffers
 * mid-string, leaving raw control characters strict JSON forbids), or the
 * concatenation would break it. Unlike {@link parseStreamingJson} this is
 * deliberately strict: forgiving repair would mask exactly the corruption
 * signals the caller needs.
 *
 * A top-level number at end-of-input classifies as `"complete"` even though
 * more digits could extend it; tool-argument buffers are always objects, so
 * the ambiguity is immaterial here.
 */
export function classifyJsonPrefix(text: string): JsonPrefixState {
	return new StrictJsonPrefix(text).classify();
}

/** How scanning a token ended: consumed whole, cut off by the end of input, or past any valid JSON. */
const enum Scan {
	Done,
	Prefix,
	Invalid,
}

/** The character code that closes the open container in each state, or -1 where nothing closes one. */
const CLOSER: Record<JsonExpect, number> = {
	[JsonExpect.Value]: -1,
	[JsonExpect.ObjKeyOrEnd]: 0x7d,
	[JsonExpect.ObjKey]: -1,
	[JsonExpect.ObjColon]: -1,
	[JsonExpect.ObjCommaOrEnd]: 0x7d,
	[JsonExpect.ArrValueOrEnd]: 0x5d,
	[JsonExpect.ArrCommaOrEnd]: 0x5d,
	[JsonExpect.End]: -1,
};

const STRICT_KEYWORDS = ["true", "false", "null"] as const;

/** Index past the run of ASCII digits starting at `i`. */
function digitsEnd(text: string, i: number): number {
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c < 0x30 || c > 0x39) break;
		i++;
	}
	return i;
}

/**
 * Index past the strict escape whose character is at `at`, one past a backslash: `text.length` when the
 * input ends inside it, or -1 when no continuation makes it valid.
 */
function strictEscapeEnd(text: string, at: number): number {
	const n = text.length;
	if (at >= n) return n;
	const e = text.charCodeAt(at);
	if (e >= 128 || !VALID_ESCAPE_CHAR[e]) return -1;
	if (e !== U) return at + 1;
	const end = Math.min(at + 5, n);
	for (let k = at + 1; k < end; k++) {
		if (!isHexDigit(text.charCodeAt(k))) return -1;
	}
	return end;
}

/** The strict RFC 8259 scanner behind {@link classifyJsonPrefix}. */
class StrictJsonPrefix {
	readonly #text: string;
	readonly #n: number;
	/** Open containers, innermost last: true for an object, false for an array. */
	readonly #stack: boolean[] = [];
	#i = 0;
	#expect = JsonExpect.Value;

	constructor(text: string) {
		this.#text = text;
		this.#n = text.length;
	}

	classify(): JsonPrefixState {
		while (this.#i < this.#n) {
			const c = this.#text.charCodeAt(this.#i);
			if (isWhitespace(c)) {
				this.#i++;
				continue;
			}
			const scan = this.#token(c);
			if (scan === Scan.Invalid) return "invalid";
			if (scan === Scan.Prefix) return "prefix";
		}
		return this.#expect === JsonExpect.End ? "complete" : "prefix";
	}

	/** Consumes the token at the cursor, whose first character is `c`, against what the grammar expects there. */
	#token(c: number): Scan {
		if (c === CLOSER[this.#expect]) {
			this.#stack.pop();
			this.#i++;
			return this.#valueDone();
		}
		switch (this.#expect) {
			case JsonExpect.Value:
			case JsonExpect.ArrValueOrEnd:
				return this.#value(c);
			case JsonExpect.ObjKeyOrEnd:
			case JsonExpect.ObjKey:
				return this.#key(c);
			case JsonExpect.ObjColon:
				return this.#separator(c, 0x3a, JsonExpect.Value);
			case JsonExpect.ObjCommaOrEnd:
				return this.#separator(c, 0x2c, JsonExpect.ObjKey);
			case JsonExpect.ArrCommaOrEnd:
				return this.#separator(c, 0x2c, JsonExpect.Value);
			case JsonExpect.End:
				return Scan.Invalid; // trailing non-whitespace after a complete value
		}
	}

	#value(c: number): Scan {
		if (c === 0x7b || c === 0x5b) {
			const object = c === 0x7b;
			this.#stack.push(object);
			this.#i++;
			this.#expect = object ? JsonExpect.ObjKeyOrEnd : JsonExpect.ArrValueOrEnd;
			return Scan.Done;
		}
		let scan: Scan;
		if (c === QUOTE) scan = this.#string();
		else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) scan = this.#number();
		else if (c === 0x74 || c === 0x66 || c === 0x6e) scan = this.#keyword();
		else return Scan.Invalid;
		return scan === Scan.Done ? this.#valueDone() : scan;
	}

	#key(c: number): Scan {
		if (c !== QUOTE) return Scan.Invalid;
		const scan = this.#string();
		if (scan === Scan.Done) this.#expect = JsonExpect.ObjColon;
		return scan;
	}

	/** Consumes `expected` when `c` is it, after which the grammar expects `next`. */
	#separator(c: number, expected: number, next: JsonExpect): Scan {
		if (c !== expected) return Scan.Invalid;
		this.#i++;
		this.#expect = next;
		return Scan.Done;
	}

	/** A value just finished; what follows it depends on the container it is in. */
	#valueDone(): Scan {
		const inObject = this.#stack.at(-1);
		this.#expect =
			inObject === undefined ? JsonExpect.End : inObject ? JsonExpect.ObjCommaOrEnd : JsonExpect.ArrCommaOrEnd;
		return Scan.Done;
	}

	/** Consumes a string from its opening quote at the cursor. */
	#string(): Scan {
		const text = this.#text;
		const n = this.#n;
		let i = this.#i + 1;
		while (i < n) {
			const c = text.charCodeAt(i);
			if (c === QUOTE) {
				this.#i = i + 1;
				return Scan.Done;
			}
			if (c < 0x20) return Scan.Invalid; // raw control char: strict JSON forbids it
			if (c !== BACKSLASH) {
				i++;
				continue;
			}
			i = strictEscapeEnd(text, i + 1);
			if (i < 0) return Scan.Invalid;
		}
		return Scan.Prefix;
	}

	/** Consumes a number from its `-` or first digit at the cursor. */
	#number(): Scan {
		const text = this.#text;
		if (text.charCodeAt(this.#i) === 0x2d) this.#i++;
		if (text.charCodeAt(this.#i) === 0x30) {
			this.#i++; // 0: no further integer digits allowed
		} else {
			const integer = this.#digits();
			if (integer !== Scan.Done) return integer;
		}
		if (text.charCodeAt(this.#i) === 0x2e) {
			this.#i++;
			const fraction = this.#digits();
			if (fraction !== Scan.Done) return fraction;
		}
		const e = text.charCodeAt(this.#i);
		if (e !== 0x65 && e !== 0x45) return Scan.Done;
		this.#i++;
		const sign = text.charCodeAt(this.#i);
		if (sign === 0x2b || sign === 0x2d) this.#i++;
		return this.#digits();
	}

	/** Consumes the one or more digits a number requires at the cursor. */
	#digits(): Scan {
		if (this.#i >= this.#n) return Scan.Prefix;
		const c = this.#text.charCodeAt(this.#i);
		if (c < 0x30 || c > 0x39) return Scan.Invalid;
		this.#i = digitsEnd(this.#text, this.#i + 1);
		return Scan.Done;
	}

	/** Consumes `true`, `false` or `null`, or the start of one the input ends in. */
	#keyword(): Scan {
		const text = this.#text;
		const i = this.#i;
		for (const word of STRICT_KEYWORDS) {
			if (word.charCodeAt(0) !== text.charCodeAt(i)) continue;
			if (this.#n - i < word.length) {
				if (!word.startsWith(text.slice(i))) return Scan.Invalid;
				this.#i = this.#n;
				return Scan.Prefix;
			}
			if (!text.startsWith(word, i)) return Scan.Invalid;
			this.#i += word.length;
			return Scan.Done;
		}
		return Scan.Invalid;
	}
}
