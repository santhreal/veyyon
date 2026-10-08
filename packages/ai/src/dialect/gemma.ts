import { AI_PROMPTS } from "../prompts/registry";
import type { Message, ToolCall } from "../types";
import { matchClose, splitTopLevel, topLevelIndexOf } from "./bracket-walk";
import {
	mintToolCallId,
	partialSuffixOverlap,
	scanOutsideText,
	scanThinkingText,
	setToolArg,
	ThinkingSection,
} from "./coercion";
import { assistantTranscriptParts, collectToolResultRun, gemmaTurn, messageContentText } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

/**
 * Gemma's own tags, every one prefixed with the dialect. The bare names collided across this directory: this
 * file's `GEMMA_CALL_OPEN` was `<|tool_call>` while `pi-native.ts` used the same name for `<call:`, and its
 * `GEMMA_RESPONSE_OPEN` was `<|tool_response>` while `glm.ts` used the same name for the shared `<tool_response>`.
 * One name standing for different bytes in sibling files is a latent bug rather than a style nit, since the
 * next reader carries the wrong meaning across the file boundary.
 */
const GEMMA_CALL_OPEN = "<|tool_call>";
const GEMMA_CALL_CLOSE = "<tool_call|>";
const STRING = '<|"|>';
const GEMMA_RESPONSE_OPEN = "<|tool_response>";
const GEMMA_RESPONSE_CLOSE = "<tool_response|>";
const OPEN_TAGS = [GEMMA_CALL_OPEN] as const;
const GEMMA_THOUGHT_OPEN = "<|channel>thought\n";
const GEMMA_THOUGHT_CLOSE = "<channel|>";
const OPEN_TAGS_THINK = [GEMMA_CALL_OPEN, GEMMA_THOUGHT_OPEN] as const;
const CALL_HEAD = /^call:\s*([A-Za-z_]\w*)\s*\{/;

type State = "outside" | "tool" | "thinking";

interface ParsedCall {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Scanner for the Gemma 4 token-delimited tool-calling convention (see
 * `docs/internal/toolconv/gemma.md`). Each call is one `<|tool_call>call:NAME{…}<tool_call|>`
 * block whose argument list is `key:value` pairs; string values are wrapped in
 * the `<|"|>` token rather than ASCII quotes, so splitting must skip those spans.
 */
class GemmaInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	readonly #thinking = new ThinkingSection();
	#call = new GemmaCallBody();
	readonly #parseThinking: boolean;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				this.#consumeOutside(final, events);
				if (this.#state === "outside") break;
				continue;
			}
			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (this.#state === "thinking") break;
				continue;
			}
			this.#consumeTool(final, events);
			if (this.#state === "tool") break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		const tags = this.#parseThinking ? OPEN_TAGS_THINK : OPEN_TAGS;
		const { buffer, tag } = scanOutsideText(this.#buffer, tags, final, events);
		this.#buffer = buffer;
		if (tag === null) return;
		if (tag === GEMMA_THOUGHT_OPEN) {
			this.#thinking.start(events);
			this.#state = "thinking";
			return;
		}
		this.#call = new GemmaCallBody();
		this.#state = "tool";
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const { buffer, closed } = scanThinkingText(this.#buffer, GEMMA_THOUGHT_CLOSE, final, this.#thinking, events);
		this.#buffer = buffer;
		if (closed) this.#state = "outside";
	}

	#endThinking(events: InbandScanEvent[]): void {
		this.#thinking.end(events);
		this.#state = "outside";
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		this.#buffer = this.#call.read(this.#buffer, final);
		if (!this.#call.closed) {
			if (final) this.#state = "outside";
			return;
		}
		const body = this.#call.text;
		const parsed = parseGemmaCall(body);
		if (parsed) {
			const id = mintToolCallId();
			events.push({ type: "toolStart", id, name: parsed.name });
			events.push({
				type: "toolEnd",
				id,
				name: parsed.name,
				arguments: parsed.arguments,
				rawBlock: `${GEMMA_CALL_OPEN}${body}${GEMMA_CALL_CLOSE}`,
			});
		}
		this.#state = "outside";
	}
}

function parseGemmaCall(body: string): ParsedCall | undefined {
	const trimmed = body.trim();
	const head = CALL_HEAD.exec(trimmed);
	if (!head) return undefined;
	const braceStart = head[0].length - 1;
	const end = matchClose(trimmed, braceStart, "{", "}", skipGemmaString);
	const argsText = end === -1 ? trimmed.slice(braceStart + 1) : trimmed.slice(braceStart + 1, end);
	return { name: head[1]!, arguments: parseGemmaArgs(argsText) };
}

function parseGemmaArgs(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const segment of splitTopLevel(text, ",", skipGemmaString)) {
		const trimmed = segment.trim();
		if (trimmed.length === 0) continue;
		const colon = topLevelIndexOf(trimmed, ":", skipGemmaString);
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		if (!/^[A-Za-z_]\w*$/.test(key)) continue;
		setToolArg(out, key, parseGemmaValue(trimmed.slice(colon + 1).trim()));
	}
	return out;
}

function parseGemmaValue(raw: string): unknown {
	const t = raw.trim();
	if (t.startsWith(STRING)) {
		const close = t.indexOf(STRING, STRING.length);
		return close === -1 ? t.slice(STRING.length) : t.slice(STRING.length, close);
	}
	if (t.startsWith("[")) {
		const end = matchClose(t, 0, "[", "]", skipGemmaString);
		const inner = end === -1 ? t.slice(1) : t.slice(1, end);
		return splitTopLevel(inner, ",", skipGemmaString)
			.map(part => part.trim())
			.filter(part => part.length > 0)
			.map(parseGemmaValue);
	}
	if (t.startsWith("{")) {
		const end = matchClose(t, 0, "{", "}", skipGemmaString);
		return parseGemmaArgs(end === -1 ? t.slice(1) : t.slice(1, end));
	}
	if (t === "true") return true;
	if (t === "false") return false;
	if (t === "null" || t === "none" || t === "None") return null;
	if (/^[+-]?(\d|\.)/.test(t)) {
		const num = Number(t);
		if (!Number.isNaN(num)) return num;
	}
	return t;
}

/** The index just past the `<|"|>`-delimited string starting at `i`, or -1 when none starts there. */
function skipGemmaString(text: string, i: number): number {
	// 0x3c is `<`, the delimiter's first code unit; testing it first skips `startsWith` at every other index.
	if (text.charCodeAt(i) !== 0x3c || !text.startsWith(STRING, i)) return -1;
	const close = text.indexOf(STRING, i + STRING.length);
	return close === -1 ? text.length : close + STRING.length;
}

/**
 * A call's body read up to its closer across stream deltas. A closer inside a `<|"|>` string is string text, so the
 * body is walked once, with whether the walk is inside a string carried from one delta to the next; only a suffix
 * that could begin a delimiter stays unread between deltas, and the body read so far is never walked again.
 */
class GemmaCallBody {
	#text = "";
	#inString = false;
	#closed = false;

	/** Whether the closer has arrived. */
	get closed(): boolean {
		return this.#closed;
	}

	/** The body read so far; once {@link closed}, everything before the closer. */
	get text(): string {
		return this.#text;
	}

	/**
	 * Reads the scanner's unread buffer and returns what stays unread: the text after the closer once it arrives,
	 * otherwise a suffix that could begin a delimiter, or nothing when `final` is set.
	 */
	read(buffer: string, final: boolean): string {
		const n = buffer.length;
		let i = 0;
		while (i < n) {
			if (this.#inString) {
				const close = buffer.indexOf(STRING, i);
				if (close === -1) {
					// Inside a string only the string's closing delimiter can end the walk.
					i = final ? n : n - Math.min(n - i, partialSuffixOverlap(buffer, STRING));
					break;
				}
				i = close + STRING.length;
				this.#inString = false;
				continue;
			}
			// 0x3c is `<`, the first code unit of both delimiters.
			if (buffer.charCodeAt(i) === 0x3c) {
				if (buffer.startsWith(STRING, i)) {
					this.#inString = true;
					i += STRING.length;
					continue;
				}
				if (buffer.startsWith(GEMMA_CALL_CLOSE, i)) {
					this.#text += buffer.slice(0, i);
					this.#closed = true;
					return buffer.slice(i + GEMMA_CALL_CLOSE.length);
				}
				if (!final && beginsDelimiter(buffer, i)) break;
			}
			i++;
		}
		this.#text += buffer.slice(0, i);
		return buffer.slice(i);
	}
}

/** Whether `text` from `i` to its end is a proper prefix of a delimiter, which the next delta may complete. */
function beginsDelimiter(text: string, i: number): boolean {
	const rest = text.length - i;
	if (rest >= GEMMA_CALL_CLOSE.length) return false;
	const tail = text.slice(i);
	return STRING.startsWith(tail) || GEMMA_CALL_CLOSE.startsWith(tail);
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	const args = Object.entries(call.arguments)
		.map(([key, value]) => `${key}:${gemmaValue(value)}`)
		.join(",");
	return `${GEMMA_CALL_OPEN}call:${call.name}{${args}}${GEMMA_CALL_CLOSE}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("");
}

function renderToolResults(results: readonly DialectToolResult[], _options: DialectRenderOptions = {}): string {
	return results
		.map(
			result =>
				`${GEMMA_RESPONSE_OPEN}response:${result.name}{output:${gemmaValue(parseMaybeJson(result.text))}}${GEMMA_RESPONSE_CLOSE}`,
		)
		.join("");
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${GEMMA_THOUGHT_OPEN}${text}${GEMMA_THOUGHT_CLOSE}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	if (messages.length === 0) return "";
	let out = "<bos>";
	for (let i = 0; i < messages.length; ) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			let body = `${renderThinking(parts.thinking)}${parts.text}${renderAssistantToolCalls(parts.toolCalls, options)}`;
			let next = i + 1;
			if (next < messages.length && messages[next]!.role === "toolResult") {
				const run = collectToolResultRun(messages, next);
				body += renderToolResults(run.results);
				next = run.next;
			}
			out += gemmaTurn("model", body);
			i = next;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += gemmaTurn("model", renderToolResults(run.results));
			i = run.next;
			continue;
		}
		const role = message.role === "developer" ? "system" : message.role;
		out += gemmaTurn(role, messageContentText(message.content));
		i++;
	}
	return out;
}

function gemmaValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return `${STRING}${value}${STRING}`;
	if (Array.isArray(value)) return `[${value.map(gemmaValue).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		return `{${entries.map(([key, val]) => `${key}:${gemmaValue(val)}`).join(",")}}`;
	}
	return `${STRING}${String(value)}${STRING}`;
}

function parseMaybeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

const definition: DialectDefinition = {
	dialect: "gemma",
	prompt: AI_PROMPTS["dialect/gemma"].text,
	createScanner: options => new GemmaInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
