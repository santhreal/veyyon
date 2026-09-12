import { parseStreamingJson, parseStreamingJsonThrottled, STREAMING_JSON_PARSE_MIN_GROWTH } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import { expandToolArguments } from "../../argot-wire";

// Top-level string args a renderer reads mid-stream. The streamed-args decode
// reads these fields incrementally between throttled full-JSON parses so a
// long payload updates preview args at reveal cadence instead of stalling for
// STREAMING_JSON_PARSE_MIN_GROWTH bytes at a time. Nested-array modes (edit
// patch/replace `edits[].diff`) still fall through to the throttled parse.
// `path`/`file_path` are here for two reasons that happen to want the same
// thing. A preview's TITLE is the path, and it arrived only when the throttled
// full parse first recovered it, so a long payload drew an untitled block for
// its opening bytes; `edit/renderer.ts` still carries a regex fallback that
// slices the path straight out of the raw buffer for exactly that window. And
// the extractor's values are argot-expanded while that raw slice is not, so a
// path carrying a handle rendered as the handle until the parse caught up.
// KEYED BY TOOL NAME, USED BY RENDERER. `tools/renderers.ts` binds one renderer
// object to several tool names, so a list written for one name silently leaves
// its siblings on the throttled parse and on the raw slice. `apply_patch` shares
// `editToolRenderer` with `edit` and was missing exactly that way: same renderer,
// same title path, same handle in the preview, no entry. The shared list is one
// const referenced twice rather than two lists that agree today, and
// `tool-args-reveal-keys-follow-the-renderer.test.ts` walks the renderer table and
// fails if any two names sharing a renderer stop sharing their keys.
const EDIT_RENDERER_STREAMING_KEYS: readonly string[] = ["path", "file_path", "input", "_input"];

const STREAMING_STRING_KEYS_BY_TOOL: Record<string, readonly string[]> = {
	write: ["path", "file_path", "content"],
	edit: EDIT_RENDERER_STREAMING_KEYS,
	apply_patch: EDIT_RENDERER_STREAMING_KEYS,
	eval: ["code"],
	launch: ["op", "name", "application", "text", "pattern", "signal"],
};

/** String fields the streamed-args decode reads incrementally for `toolName`. */
export function streamingStringKeysForTool(toolName: string, rawInput: boolean): readonly string[] | undefined {
	if (rawInput) return undefined;
	return STREAMING_STRING_KEYS_BY_TOOL[toolName];
}

export type StreamingJsonStringExtractorResult = {
	values: Record<string, string>;
	changed: boolean;
};

function decodeJsonStringEscape(ch: string): string {
	switch (ch) {
		case '"':
		case "\\":
		case "/":
			return ch;
		case "b":
			return "\b";
		case "f":
			return "\f";
		case "n":
			return "\n";
		case "r":
			return "\r";
		case "t":
			return "\t";
		default:
			return ch;
	}
}

function isHexDigit(ch: string): boolean {
	return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

export type StreamingJsonStringExtractorState = "scan" | "candidate" | "afterCandidate" | "beforeValue" | "target";

export class StreamingJsonStringExtractor {
	readonly #keys: Set<string>;
	#source = "";
	#offset = 0;
	/** `{`/`[` nesting outside strings. Candidate keys match only at depth 1 —
	 *  the top level of the args object — so a nested object's key (e.g.
	 *  `{"meta":{"content":…}}`) is never captured as a streamed top-level arg. */
	#depth = 0;
	#state: StreamingJsonStringExtractorState = "scan";
	#candidate = "";
	#candidateEscaped = false;
	#candidateUnicode = "";
	#matchedKey: string | undefined;
	#targetKey: string | undefined;
	#targetEscaped = false;
	#targetUnicode = "";
	#values: Record<string, string> = {};
	#changed = false;

	constructor(keys: readonly string[]) {
		this.#keys = new Set(keys);
	}

	reset(): void {
		this.#source = "";
		this.#offset = 0;
		this.#depth = 0;
		this.#state = "scan";
		this.#candidate = "";
		this.#candidateEscaped = false;
		this.#candidateUnicode = "";
		this.#matchedKey = undefined;
		this.#targetKey = undefined;
		this.#targetEscaped = false;
		this.#targetUnicode = "";
		this.#values = {};
		this.#changed = false;
	}

	update(prefix: string): StreamingJsonStringExtractorResult {
		if (!prefix.startsWith(this.#source)) {
			this.reset();
		}
		this.#source = prefix;
		this.#changed = false;
		while (this.#offset < prefix.length) {
			const ch = prefix[this.#offset]!;
			switch (this.#state) {
				case "scan":
					this.#scan(ch);
					break;
				case "candidate":
					this.#readCandidate(ch);
					break;
				case "afterCandidate":
					this.#afterCandidate(ch);
					break;
				case "beforeValue":
					this.#beforeValue(ch);
					break;
				case "target":
					this.#readTarget(ch);
					break;
			}
		}
		return { values: { ...this.#values }, changed: this.#changed };
	}

	#scan(ch: string): void {
		if (ch === '"') {
			this.#candidate = "";
			this.#candidateEscaped = false;
			this.#candidateUnicode = "";
			this.#state = "candidate";
		} else if (ch === "{" || ch === "[") {
			this.#depth++;
		} else if (ch === "}" || ch === "]") {
			this.#depth--;
		}
		this.#offset++;
	}

	#readCandidate(ch: string): void {
		if (this.#candidateUnicode) {
			this.#readCandidateUnicode(ch);
			return;
		}
		if (this.#candidateEscaped) {
			if (ch === "u") {
				this.#candidateUnicode = "u";
			} else {
				this.#candidate += decodeJsonStringEscape(ch);
				this.#candidateEscaped = false;
			}
			this.#offset++;
			return;
		}
		if (ch === "\\") {
			this.#candidateEscaped = true;
			this.#offset++;
			return;
		}
		if (ch === '"') {
			this.#matchedKey = this.#depth === 1 && this.#keys.has(this.#candidate) ? this.#candidate : undefined;
			this.#state = "afterCandidate";
			this.#offset++;
			return;
		}
		this.#candidate += ch;
		this.#offset++;
	}

	#readCandidateUnicode(ch: string): void {
		if (isHexDigit(ch)) {
			this.#candidateUnicode += ch;
			if (this.#candidateUnicode.length === 5) {
				this.#candidate += String.fromCharCode(Number.parseInt(this.#candidateUnicode.slice(1), 16));
				this.#candidateUnicode = "";
				this.#candidateEscaped = false;
			}
		} else {
			this.#candidate += this.#candidateUnicode + ch;
			this.#candidateUnicode = "";
			this.#candidateEscaped = false;
		}
		this.#offset++;
	}

	#afterCandidate(ch: string): void {
		if (/\s/.test(ch)) {
			this.#offset++;
			return;
		}
		const matchedKey = this.#matchedKey;
		this.#matchedKey = undefined;
		if (ch === ":" && matchedKey) {
			this.#targetKey = matchedKey;
			this.#state = "beforeValue";
			this.#offset++;
			return;
		}
		this.#state = "scan";
	}

	#beforeValue(ch: string): void {
		if (/\s/.test(ch)) {
			this.#offset++;
			return;
		}
		if (ch === '"' && this.#targetKey) {
			if (this.#values[this.#targetKey]) {
				this.#values[this.#targetKey] = "";
				this.#changed = true;
			}
			this.#targetEscaped = false;
			this.#targetUnicode = "";
			this.#state = "target";
			this.#offset++;
			return;
		}
		this.#targetKey = undefined;
		this.#state = "scan";
	}

	#readTarget(ch: string): void {
		if (this.#targetUnicode) {
			this.#readTargetUnicode(ch);
			return;
		}
		if (this.#targetEscaped) {
			if (ch === "u") {
				this.#targetUnicode = "u";
			} else {
				this.#appendTarget(decodeJsonStringEscape(ch));
				this.#targetEscaped = false;
			}
			this.#offset++;
			return;
		}
		if (ch === "\\") {
			this.#targetEscaped = true;
			this.#offset++;
			return;
		}
		if (ch === '"') {
			this.#targetKey = undefined;
			this.#state = "scan";
			this.#offset++;
			return;
		}
		this.#appendTarget(ch);
		this.#offset++;
	}

	#readTargetUnicode(ch: string): void {
		if (isHexDigit(ch)) {
			this.#targetUnicode += ch;
			if (this.#targetUnicode.length === 5) {
				this.#appendTarget(String.fromCharCode(Number.parseInt(this.#targetUnicode.slice(1), 16)));
				this.#targetUnicode = "";
				this.#targetEscaped = false;
			}
		} else {
			this.#appendTarget(this.#targetUnicode + ch);
			this.#targetUnicode = "";
			this.#targetEscaped = false;
		}
		this.#offset++;
	}

	#appendTarget(text: string): void {
		if (!this.#targetKey || text.length === 0) return;
		this.#values[this.#targetKey] = `${this.#values[this.#targetKey] ?? ""}${text}`;
		this.#changed = true;
	}
}

export function createStringExtractor(keys: readonly string[] | undefined): StreamingJsonStringExtractor | undefined {
	return keys && keys.length > 0 ? new StreamingJsonStringExtractor(keys) : undefined;
}

export function sameStringKeys(a: readonly string[], b: readonly string[] | undefined): boolean {
	if (a.length !== (b?.length ?? 0)) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b?.[i]) return false;
	}
	return true;
}

/** Clamp a slice end into `text`, never splitting a surrogate pair: a prefix
 *  ending on a high surrogate would feed a lone surrogate into the parsed
 *  preview args (providers decode UTF-8 incrementally, so the raw stream
 *  itself never contains one). */
export function clampSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end + 1 : end;
}

export type StreamedToolArgsSource = {
	/** Custom-tool raw text stream (`customWireName` tools): never JSON-parsed. */
	rawInput: boolean;
	/** Provider-parsed arguments, spread UNDER the fresh decode: a dialect
	 *  projector may carry keys a raw re-parse cannot recover, but any key the
	 *  fresh parse does recover wins — provider parses lag the stream by up to
	 *  STREAMING_JSON_PARSE_MIN_GROWTH bytes mid-stream. */
	fullArgs?: Record<string, unknown>;
	/** See {@link streamingStringKeysForTool}. */
	streamingStringKeys?: readonly string[];
	/**
	 * The session's argot codec, when one is armed.
	 *
	 * A streaming preview renders arguments that have NOT reached the tool yet, so
	 * they still carry `§handle` fragments: expansion happens at seam 1, just
	 * before execution. Without this the preview of a write or an edit shows the
	 * handle instead of the text it stands for, for as long as the call streams.
	 *
	 * Undefined when argot is off, and `expandStreamedValues` is identity while the
	 * codec has no dictionary loaded, so the inert path is byte-for-byte unchanged.
	 */
	argot?: ArgotSession;
};

/**
 * Expand handles in decoded argument VALUES, never in the buffer they came from.
 *
 * THE CONSTRAINT THAT SHAPES THIS. A handle can expand to text containing `"`,
 * `\` or a newline. Expanding the raw partial JSON as TEXT would splice those
 * bytes inside the string literal they sit in and corrupt the very JSON the next
 * frame has to parse. So expansion happens strictly AFTER a value leaves the
 * partial-JSON layer, which is the same rule seam 1 follows: `expandToolArguments`
 * maps parsed string values, it does not rewrite a request body.
 *
 * Routed through `expandToolArguments` rather than calling `argot.expand` here so
 * the expansion rule has one owner; see `src/argot-wire.ts`.
 */
export function expandStreamedValues(
	argot: ArgotSession | undefined,
	values: Record<string, unknown>,
): Record<string, unknown> {
	return argot ? expandToolArguments(argot, values) : values;
}

/**
 * Expand handles in a string a `__partialJson` extractor already pulled out.
 *
 * Used only for a CUSTOM tool's stream, where `__partialJson` carries raw text
 * rather than JSON, so both it and `input` are values and neither can be
 * corrupted by expansion. Module-private on purpose: a caller outside this file
 * holding a raw buffer would be holding JSON, and expanding that is the one
 * thing this whole arrangement exists to prevent.
 *
 * A handle still arriving at the buffer's edge stays raw for at most one frame,
 * because the next frame carries more bytes and the frame after that is the
 * wholesale expansion at execution. This is not a fallback: nothing is skipped
 * and nothing degrades, the text simply has not been received yet.
 */
export function expandStreamedPreviewText(argot: ArgotSession | undefined, text: string): string {
	if (!argot?.loaded) return text;
	return argot.expand(text);
}

/**
 * One-shot decode of a streamed tool-call argument buffer into display args —
 * the same decode the live reveal applies frame-by-frame, for paths that see
 * the buffer once (transcript rebuilds on theme change, settings, focus
 * replay). Keeps a rebuilt preview identical to the live preview: parsed
 * fields come from a fresh parse of the full buffer, `streamingStringKeys`
 * fields from the incremental string decoder (which also wins ties in the
 * live path), never from the provider's throttled `arguments`.
 */
export function decodeStreamedToolArgs(partialJson: string, source: StreamedToolArgsSource): Record<string, unknown> {
	if (source.rawInput) {
		// A custom tool's stream is raw TEXT, not JSON, so both fields are values and
		// expanding them cannot corrupt a structure. This is the one place
		// `__partialJson` is safe to expand, and it has to be: `tool-execution.ts`
		// recovers a missing `input` from that field directly.
		const text = expandStreamedPreviewText(source.argot, partialJson);
		return { input: text, __partialJson: text };
	}
	const parsed = expandStreamedValues(
		source.argot,
		parseStreamingJson<Record<string, unknown>>(partialJson) as Record<string, unknown>,
	);
	const args: Record<string, unknown> = source.fullArgs ? { ...source.fullArgs, ...parsed } : { ...parsed };
	const extracted = createStringExtractor(source.streamingStringKeys)?.update(partialJson);
	if (extracted) Object.assign(args, expandStreamedValues(source.argot, extracted.values));
	// The RAW prefix stays raw on purpose: it is JSON, and expanding it would splice
	// a quote or a newline into the string literal a handle sits in. A renderer that
	// slices a field out of it therefore sees the WIRE form, which is why every field
	// a renderer surfaces belongs in `streamingStringKeys` above: those values are
	// decoded and expanded here, and a renderer prefers them over its own slice.
	args.__partialJson = partialJson;
	return args;
}

export type DisplayArgsStep = {
	args: Record<string, unknown>;
	changed: boolean;
};

export function initialDisplayArgs(): Record<string, unknown> {
	return { __partialJson: "" };
}

export type IncrementalStreamedToolArgsState = {
	rawInput: boolean;
	exposeRawPartialJson: boolean;
	parsedArgs: Record<string, unknown>;
	parsedLen: number;
	displayArgs: Record<string, unknown>;
	displayPrefix: string;
	stringExtractor?: StreamingJsonStringExtractor;
	argot?: ArgotSession;
};

export function resetDisplayState(state: {
	parsedArgs: Record<string, unknown>;
	parsedLen: number;
	displayArgs: Record<string, unknown>;
	displayPrefix: string;
	stringExtractor?: StreamingJsonStringExtractor;
}): void {
	state.parsedArgs = {};
	state.parsedLen = 0;
	state.displayArgs = initialDisplayArgs();
	state.displayPrefix = "";
	state.stringExtractor?.reset();
}

/** Display args for a revealed prefix. Function-tool JSON is parsed at the same
 * growth-throttled cadence providers use, so a long `write` payload cannot make
 * the reveal loop re-parse the whole growing buffer every frame. Renderers that
 * read raw JSON directly still receive fresh `__partialJson` prefixes; other
 * renderers get a stable object reference while parsed fields are unchanged. */
export function displayArgsForPrefix(
	state: IncrementalStreamedToolArgsState,
	prefix: string,
	forceParse = false,
): DisplayArgsStep {
	if (state.rawInput) {
		if (prefix === state.displayPrefix) return { args: state.displayArgs, changed: false };
		// Raw text, not JSON: see the same branch in `decodeStreamedToolArgs`.
		const text = expandStreamedPreviewText(state.argot, prefix);
		const args = { input: text, __partialJson: text };
		state.displayArgs = args;
		// The RAW prefix is what the change check compares, so the unexpanded one is
		// kept: comparing expanded text would re-render whenever a dictionary loaded.
		state.displayPrefix = prefix;
		return { args, changed: true };
	}

	let parsedChanged = false;
	if (forceParse || (prefix.length > 0 && prefix.length < STREAMING_JSON_PARSE_MIN_GROWTH)) {
		state.parsedArgs = expandStreamedValues(state.argot, parseStreamingJson<Record<string, unknown>>(prefix));
		state.parsedLen = prefix.length;
		parsedChanged = true;
	} else {
		const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(prefix, state.parsedLen);
		if (throttled) {
			state.parsedArgs = expandStreamedValues(state.argot, throttled.value);
			state.parsedLen = throttled.parsedLen;
			parsedChanged = true;
		}
	}
	const extracted = state.stringExtractor?.update(prefix);
	if (extracted?.changed) {
		state.parsedArgs = { ...state.parsedArgs, ...expandStreamedValues(state.argot, extracted.values) };
		parsedChanged = true;
	}

	const rawPrefixChanged = state.exposeRawPartialJson && prefix !== state.displayPrefix;
	if (!parsedChanged && !rawPrefixChanged) return { args: state.displayArgs, changed: false };

	const displayPrefix = state.exposeRawPartialJson || parsedChanged ? prefix : state.displayPrefix;
	const args = { ...state.parsedArgs, __partialJson: displayPrefix };
	state.displayArgs = args;
	state.displayPrefix = displayPrefix;
	return { args, changed: true };
}
