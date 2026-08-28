import { setSafeProperty } from "./type-guards";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const U = 0x75;
const SQUOTE = 0x27;

const VALID_ESCAPE_CHAR = new Uint8Array(128);
for (const ch of '"\\/bfnrtu') VALID_ESCAPE_CHAR[ch.charCodeAt(0)] = 1;

const CONTROL_ESCAPES: readonly string[] = (() => {
	const escapes = new Array<string>(32);
	for (let i = 0; i < 32; i++) {
		escapes[i] =
			i === 0x08
				? "\\b"
				: i === 0x09
					? "\\t"
					: i === 0x0a
						? "\\n"
						: i === 0x0c
							? "\\f"
							: i === 0x0d
								? "\\r"
								: `\\u00${i.toString(16).padStart(2, "0")}`;
	}
	return escapes;
})();

const HEX4_RE = /^[0-9a-fA-F]{4}$/;

function isHexDigit(cp: number): boolean {
	return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
}

function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function isIdentChar(cp: number): boolean {
	return (
		(cp >= 0x61 && cp <= 0x7a) ||
		(cp >= 0x41 && cp <= 0x5a) ||
		(cp >= 0x30 && cp <= 0x39) ||
		cp === 0x5f ||
		cp === 0x24
	);
}

const KEYWORDS: readonly (readonly [string, unknown])[] = [
	["true", true],
	["false", false],
	["null", null],
	["True", true],
	["False", false],
	["None", null],
];

const NON_RECOVERABLE_BAREWORDS: Record<string, true> = {
	NaN: true,
	nan: true,
	Infinity: true,
	infinity: true,
	undefined: true,
};

const INCOMPLETE = Symbol("incomplete");

/** Lightweight string-level repair for escape/control-char hazards in JSON. */
export function repairJson(json: string): string {
	const len = json.length;
	const parts: string[] = [];
	let lastEmit = 0;
	let inString = false;
	let i = 0;

	while (i < len) {
		if (!inString) {
			while (i < len && json.charCodeAt(i) !== QUOTE) i++;
			if (i >= len) break;
			inString = true;
			i++;
			continue;
		}

		while (i < len) {
			const cp = json.charCodeAt(i);
			if (cp < 0x20 || cp === QUOTE || cp === BACKSLASH) break;
			i++;
		}
		if (i >= len) break;

		const cp = json.charCodeAt(i);

		if (cp === QUOTE) {
			inString = false;
			i++;
			continue;
		}

		if (cp === BACKSLASH) {
			if (i + 1 >= len) {
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			const nextCp = json.charCodeAt(i + 1);

			if (nextCp === U) {
				if (
					i + 5 < len &&
					isHexDigit(json.charCodeAt(i + 2)) &&
					isHexDigit(json.charCodeAt(i + 3)) &&
					isHexDigit(json.charCodeAt(i + 4)) &&
					isHexDigit(json.charCodeAt(i + 5))
				) {
					i += 6;
					continue;
				}
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			if (nextCp < 128 && VALID_ESCAPE_CHAR[nextCp] === 1) {
				i += 2;
				continue;
			}

			parts.push(json.slice(lastEmit, i), "\\\\");
			lastEmit = i + 1;
			i++;
			continue;
		}

		parts.push(json.slice(lastEmit, i), CONTROL_ESCAPES[cp]);
		lastEmit = i + 1;
		i++;
	}

	if (!parts.length) return json;
	if (lastEmit < len) parts.push(json.slice(lastEmit));
	return parts.join("");
}

/** Recursive-descent parser for relaxed JSON with streaming recovery. */
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
			if (this.#i + 1 < this.#n && s.charCodeAt(this.#i) === 0x2f) {
				const next = s.charCodeAt(this.#i + 1);
				if (next === 0x2f) {
					this.#i += 2;
					while (this.#i < this.#n && s.charCodeAt(this.#i) !== 0x0a) this.#i++;
					continue;
				}
				if (next === 0x2a) {
					this.#i += 2;
					while (
						this.#i + 1 < this.#n &&
						!(s.charCodeAt(this.#i) === 0x2a && s.charCodeAt(this.#i + 1) === 0x2f)
					) {
						this.#i++;
					}
					this.#i = Math.min(this.#i + 2, this.#n);
					continue;
				}
			}
			break;
		}
	}

	#value(allowBareword: boolean): unknown {
		const s = this.#s;
		const c = s[this.#i];
		if (c === "{") return this.#object();
		if (c === "[") return this.#array();
		if (c === '"' || c === "'") return this.#string(s.charCodeAt(this.#i));
		const cc = s.charCodeAt(this.#i);
		if (cc === 0x2d || cc === 0x2b || cc === 0x2e || (cc >= 0x30 && cc <= 0x39)) {
			return this.#number();
		}
		return this.#keyword(allowBareword);
	}

	#object(): Record<string, unknown> {
		this.#i++;
		const out: Record<string, unknown> = {};
		for (;;) {
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated object");
			}
			const c = this.#s[this.#i];
			if (c === "}") {
				this.#i++;
				return out;
			}
			if (c === ",") {
				this.#i++;
				continue;
			}
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
			setSafeProperty(out, key, value);
			this.#ws();
			const d = this.#i < this.#n ? this.#s[this.#i] : "";
			if (d === ",") {
				this.#i++;
				continue;
			}
			if (d === "}") {
				this.#i++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or '}' in object");
		}
	}

	#array(): unknown[] {
		this.#i++;
		const out: unknown[] = [];
		for (;;) {
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated array");
			}
			const c = this.#s[this.#i];
			if (c === "]") {
				this.#i++;
				return out;
			}
			if (c === ",") {
				this.#i++;
				continue;
			}
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			out.push(value);
			this.#ws();
			const d = this.#i < this.#n ? this.#s[this.#i] : "";
			if (d === ",") {
				this.#i++;
				continue;
			}
			if (d === "]") {
				this.#i++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or ']' in array");
		}
	}

	#key(): string {
		const c = this.#s[this.#i];
		if (c === '"' || c === "'") return this.#string(this.#s.charCodeAt(this.#i));
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
		let i = this.#i + 1;
		let out = "";
		let runStart = i;
		while (i < n) {
			const cc = s.charCodeAt(i);
			if (cc !== BACKSLASH && cc !== quote) {
				i++;
				continue;
			}
			if (cc === quote) {
				const lenient = quote === SQUOTE || this.#partial;
				if (!lenient || this.#closesString(i + 1)) {
					out += s.slice(runStart, i);
					this.#i = i + 1;
					return out;
				}
				i++;
				continue;
			}
			out += s.slice(runStart, i);
			i++;
			if (i >= n) {
				out += "\\";
				runStart = i;
				break;
			}
			const esc = s.charCodeAt(i);
			switch (esc) {
				case QUOTE:
					out += '"';
					break;
				case SQUOTE:
					out += "'";
					break;
				case BACKSLASH:
					out += "\\";
					break;
				case 0x2f:
					out += "/";
					break;
				case 0x62:
					out += "\b";
					break;
				case 0x66:
					out += "\f";
					break;
				case 0x6e:
					out += "\n";
					break;
				case 0x72:
					out += "\r";
					break;
				case 0x74:
					out += "\t";
					break;
				case U: {
					const hex = s.slice(i + 1, i + 5);
					if (HEX4_RE.test(hex)) {
						out += String.fromCharCode(parseInt(hex, 16));
						i += 4;
					} else {
						out += "\\u";
					}
					break;
				}
				default:
					out += `\\${s[i]}`;
			}
			i++;
			runStart = i;
		}
		out += s.slice(runStart, i);
		if (this.#partial) {
			this.#i = i;
			return out;
		}
		throw new SyntaxError("Unterminated string");
	}

	#closesString(from: number): boolean {
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
			if (s.startsWith(word, i) && !isIdentChar(s.charCodeAt(i + word.length))) {
				this.#i += word.length;
				return value;
			}
		}
		if (this.#partial) {
			this.#i = this.#n;
			return INCOMPLETE;
		}
		if (allowBareword) return this.#bareword();
		throw new SyntaxError(`Unexpected token at position ${this.#i}`);
	}

	#bareword(): string {
		const s = this.#s;
		const start = this.#i;
		let i = start;
		while (i < this.#n) {
			const cc = s.charCodeAt(i);
			if (cc === 0x2c || cc === 0x7d || cc === 0x5d || cc === 0x0a || cc === 0x0d) break;
			if (
				cc === QUOTE ||
				cc === 0x7b ||
				cc === 0x5b ||
				(cc === 0x3a && s.charCodeAt(i + 1) !== 0x2f && s.charCodeAt(i + 1) !== 0x5c)
			) {
				throw new SyntaxError(`Unexpected token at position ${start}`);
			}
			i++;
		}
		if (i >= this.#n) throw new SyntaxError(`Unexpected token at position ${start}`);
		let end = i;
		while (end > start && isWhitespace(s.charCodeAt(end - 1))) end--;
		const word = s.slice(start, end);
		if (Object.hasOwn(NON_RECOVERABLE_BAREWORDS, word))
			throw new SyntaxError(`Unexpected token at position ${start}`);
		this.#i = i;
		return word;
	}
}

/** Parse a JSON value with relaxed fallback repairs. */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return new RelaxedJson(json, false).parse() as T;
	}
}

/** Parse possibly-incomplete JSON during streaming. */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson) return {} as T;
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		const trimmed = partialJson.trimStart();
		if (!trimmed) return {} as T;
		try {
			return (new RelaxedJson(trimmed, true).parse() ?? {}) as T;
		} catch {
			return {} as T;
		}
	}
}

/** Default minimum byte growth before re-parsing streaming JSON. */
export const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

/** Throttled variant of parseStreamingJson for delta streaming. */
export function parseStreamingJsonThrottled<T = Record<string, unknown>>(
	partialJson: string | undefined,
	lastParsedLen: number,
	minGrowthBytes: number = STREAMING_JSON_PARSE_MIN_GROWTH,
): { value: T; parsedLen: number } | null {
	const len = partialJson?.length ?? 0;
	if (len === 0 || (lastParsedLen > 0 && len - lastParsedLen < minGrowthBytes)) return null;
	return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}

export type JsonPrefixState = "complete" | "prefix" | "invalid";

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

/** Classify text as a strict-JSON value, prefix, or dead end. */
export function classifyJsonPrefix(text: string): JsonPrefixState {
	const n = text.length;
	let i = 0;
	const stack: boolean[] = [];
	let expect = JsonExpect.Value;

	const scanString = (): 1 | 0 | -1 => {
		i++;
		while (i < n) {
			const c = text.charCodeAt(i);
			if (c === QUOTE) {
				i++;
				return 1;
			}
			if (c === BACKSLASH) {
				i++;
				if (i >= n) return 0;
				const e = text.charCodeAt(i);
				if (e >= 128 || !VALID_ESCAPE_CHAR[e]) return -1;
				i++;
				if (e === U) {
					for (let k = 0; k < 4; k++, i++) {
						if (i >= n) return 0;
						if (!isHexDigit(text.charCodeAt(i))) return -1;
					}
				}
				continue;
			}
			if (c < 0x20) return -1;
			i++;
		}
		return 0;
	};

	const scanNumber = (): 1 | 0 | -1 => {
		if (text.charCodeAt(i) === 0x2d) i++;
		if (i >= n) return 0;
		let c = text.charCodeAt(i);
		if (c === 0x30) {
			i++;
		} else if (c >= 0x31 && c <= 0x39) {
			while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
		} else {
			return -1;
		}
		if (i < n && text.charCodeAt(i) === 0x2e) {
			i++;
			if (i >= n) return 0;
			if (text.charCodeAt(i) < 0x30 || text.charCodeAt(i) > 0x39) return -1;
			while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
		}
		c = i < n ? text.charCodeAt(i) : 0;
		if (c === 0x65 || c === 0x45) {
			i++;
			if (i < n && (text.charCodeAt(i) === 0x2b || text.charCodeAt(i) === 0x2d)) i++;
			if (i >= n) return 0;
			if (text.charCodeAt(i) < 0x30 || text.charCodeAt(i) > 0x39) return -1;
			while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
		}
		return 1;
	};

	const scanKeyword = (): 1 | 0 | -1 => {
		for (const word of ["true", "false", "null"] as const) {
			if (word.charCodeAt(0) !== text.charCodeAt(i)) continue;
			const available = Math.min(word.length, n - i);
			if (!word.startsWith(text.slice(i, i + available))) return -1;
			i += available;
			return available === word.length ? 1 : 0;
		}
		return -1;
	};

	const valueDone = (): JsonExpect =>
		stack.length === 0
			? JsonExpect.End
			: stack[stack.length - 1]
				? JsonExpect.ObjCommaOrEnd
				: JsonExpect.ArrCommaOrEnd;

	while (i < n) {
		const c = text.charCodeAt(i);
		if (isWhitespace(c)) {
			i++;
			continue;
		}
		switch (expect) {
			case JsonExpect.Value:
			case JsonExpect.ArrValueOrEnd: {
				if (c === 0x5d && expect === JsonExpect.ArrValueOrEnd) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c === 0x7b) {
					stack.push(true);
					i++;
					expect = JsonExpect.ObjKeyOrEnd;
					break;
				}
				if (c === 0x5b) {
					stack.push(false);
					i++;
					expect = JsonExpect.ArrValueOrEnd;
					break;
				}
				let r: 1 | 0 | -1;
				if (c === QUOTE) r = scanString();
				else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) r = scanNumber();
				else if (c === 0x74 || c === 0x66 || c === 0x6e) r = scanKeyword();
				else return "invalid";
				if (r === -1) return "invalid";
				if (r === 0) return "prefix";
				expect = valueDone();
				break;
			}
			case JsonExpect.ObjKeyOrEnd:
			case JsonExpect.ObjKey: {
				if (c === 0x7d && expect === JsonExpect.ObjKeyOrEnd) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c !== QUOTE) return "invalid";
				const r = scanString();
				if (r === -1) return "invalid";
				if (r === 0) return "prefix";
				expect = JsonExpect.ObjColon;
				break;
			}
			case JsonExpect.ObjColon:
				if (c !== 0x3a) return "invalid";
				i++;
				expect = JsonExpect.Value;
				break;
			case JsonExpect.ObjCommaOrEnd:
				if (c === 0x7d) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c !== 0x2c) return "invalid";
				i++;
				expect = JsonExpect.ObjKey;
				break;
			case JsonExpect.ArrCommaOrEnd:
				if (c === 0x5d) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c !== 0x2c) return "invalid";
				i++;
				expect = JsonExpect.Value;
				break;
			case JsonExpect.End:
				return "invalid";
		}
	}
	return expect === JsonExpect.End ? "complete" : "prefix";
}
