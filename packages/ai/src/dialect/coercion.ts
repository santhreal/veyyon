import { parseJsonWithRepair, parseStreamingJson } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { errorMessage, getOwnProperty, isRecord, setSafeProperty } from "@veyyon/utils/type-guards";
import type { ToolCall } from "../types";
import { toolWireSchema } from "../utils/schema";
import type { FencedThinkingScanner } from "./fenced-thinking";
import type { InbandScanEvent, InbandTool, InbandToolEnd } from "./types";

export interface ToolArgShape {
	stringArgs: Set<string>;
	properties: Record<string, unknown>;
	parameterOrder: string[];
}

export function buildArgShapes(tools: readonly InbandTool[] = []): Map<string, ToolArgShape> {
	const shapes = new Map<string, ToolArgShape>();
	for (const tool of tools) {
		const schema = resolveToolSchema(tool);
		const props = schema.properties;
		const properties = isRecord(props) ? props : {};
		const stringArgs = new Set<string>();
		const parameterOrder: string[] = [];
		for (const key in properties) {
			parameterOrder.push(key);
			if (isStringOnlySchema(properties[key])) stringArgs.add(key);
		}
		shapes.set(tool.name, { stringArgs, properties, parameterOrder });
	}
	return shapes;
}

export function buildStringArgsResolver(tools: readonly InbandTool[] = []): (toolName: string) => ReadonlySet<string> {
	const shapes = buildArgShapes(tools);
	const empty = new Set<string>();
	return (toolName: string) => shapes.get(toolName)?.stringArgs ?? empty;
}

export function resolveToolSchema(tool: InbandTool): Record<string, unknown> {
	try {
		return toolWireSchema(tool);
	} catch {
		const params = tool.parameters;
		return isRecord(params) ? params : {};
	}
}

export function isStringOnlySchema(schema: unknown): boolean {
	const types = collectSchemaTypes(schema);
	types.delete("null");
	return types.size === 1 && types.has("string");
}

export function collectSchemaTypes(schema: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
	if (depth > 8 || !isRecord(schema)) return out;
	const node = schema as Record<string, unknown>;
	const type = node.type;
	if (typeof type === "string") out.add(type);
	else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") out.add(t);
	if (type === undefined && Array.isArray(node.enum)) {
		for (const value of node.enum) out.add(jsonTypeOf(value));
	}
	if (type === undefined && "const" in node) out.add(jsonTypeOf(node.const));
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const branch = node[key];
		if (Array.isArray(branch)) for (const sub of branch) collectSchemaTypes(sub, out, depth + 1);
	}
	return out;
}

export function jsonTypeOf(value: unknown): string {
	const type = typeof value;
	if (value === null) return "null";
	if (type === "number" || type === "bigint") return "number";
	if (type === "boolean") return "boolean";
	if (type === "string") return "string";
	return "object";
}

export function decodeValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return trimmed;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return raw;
	}
}

export function coerceValue(raw: string, schema: unknown): unknown {
	return isStringOnlySchema(schema) ? raw : decodeValue(raw);
}

export function isArraySchema(schema: unknown): boolean {
	return collectSchemaTypes(schema).has("array");
}

export function isObjectSchema(schema: unknown): boolean {
	return collectSchemaTypes(schema).has("object");
}

export function getObjectProperties(schema: unknown): Record<string, unknown> {
	if (!isRecord(schema)) return {};
	const props = (schema as Record<string, unknown>).properties;
	return isRecord(props) ? props : {};
}

export function getArrayItemSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return undefined;
	return (schema as Record<string, unknown>).items;
}

let idCounter = 0;
export function mintToolCallId(): string {
	idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `ptc_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * The length of the longest proper prefix of `tag` that `text` ends with: the
 * part of a tag a scanner holds back until the next delta shows whether the tag
 * completes. Runs on every streamed delta, so it allocates nothing and compares
 * only at positions holding the tag's first character.
 */
export function partialSuffixOverlap(text: string, tag: string): number {
	const end = text.length;
	const max = Math.min(end, tag.length - 1);
	if (max <= 0) return 0;
	const first = tag[0];
	// The longest overlap starts earliest, so candidate starts are scanned left to right.
	for (let start = text.indexOf(first, end - max); start !== -1; start = text.indexOf(first, start + 1)) {
		const k = end - start;
		let i = 1;
		while (i < k && text.charCodeAt(start + i) === tag.charCodeAt(i)) i++;
		if (i === k) return k;
	}
	return 0;
}

export function partialSuffixOverlapAny(text: string, tags: readonly string[]): number {
	let best = 0;
	for (const tag of tags) best = Math.max(best, partialSuffixOverlap(text, tag));
	return best;
}

/** The earliest occurrence of any of `tags` in `text`; on a tie, the tag listed first. */
export interface TagMatch {
	index: number;
	tag: string;
}

export function findFirstTag(text: string, tags: readonly string[]): TagMatch | null {
	let best: TagMatch | null = null;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index === -1) continue;
		if (!best || index < best.index) best = { index, tag };
	}
	return best;
}

/**
 * Emit `buffer` as one text event, except a suffix that could be the start of one of `tags`, which
 * is returned to stay held until more text arrives. With `final` set nothing is held.
 */
export function emitTextHoldingPartialTag(
	buffer: string,
	tags: readonly string[],
	final: boolean,
	events: InbandScanEvent[],
): string {
	const emitEnd = final ? buffer.length : buffer.length - partialSuffixOverlapAny(buffer, tags);
	if (emitEnd > 0) events.push({ type: "text", text: buffer.slice(0, emitEnd) });
	return buffer.slice(emitEnd);
}

/**
 * One step of a scanner's outside-of-any-block state: the text before the first
 * of `tags` is emitted as a text event and the buffer advances past the tag.
 * With no tag present the whole buffer is emitted, except a suffix that could be
 * the start of a tag, which stays held until more text arrives or `final`
 * is set. Every in-band scanner opens its blocks this way; the differences
 * between dialects begin at the tag it returns.
 */
export function scanOutsideText(
	buffer: string,
	tags: readonly string[],
	final: boolean,
	events: InbandScanEvent[],
): { buffer: string; tag: string | null } {
	const match = findFirstTag(buffer, tags);
	if (!match) return { buffer: emitTextHoldingPartialTag(buffer, tags, final, events), tag: null };
	if (match.index > 0) events.push({ type: "text", text: buffer.slice(0, match.index) });
	return { buffer: buffer.slice(match.index + match.tag.length), tag: match.tag };
}

/**
 * The reasoning a scanner has streamed since its `thinkingStart`: each delta is
 * pushed as it arrives and the joined text rides on the `thinkingEnd`. The
 * scanner keeps the section as a field and moves its own state around it.
 */
export class ThinkingSection {
	#text = "";

	start(events: InbandScanEvent[]): void {
		this.#text = "";
		events.push({ type: "thinkingStart" });
	}

	delta(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#text += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	end(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#text });
		this.#text = "";
	}
}

/**
 * One step of a scanner's inside-a-thinking-section state for a section closed
 * by one literal tag: the text before `closeTag` is streamed into `section`,
 * except a suffix that could be the start of the tag, which stays held until
 * more text arrives or `final` is set. The section ends when the tag arrives or
 * the stream does; `closed` is true on either, and the caller then leaves its
 * thinking state.
 */
export function scanThinkingText(
	buffer: string,
	closeTag: string,
	final: boolean,
	section: ThinkingSection,
	events: InbandScanEvent[],
): { buffer: string; closed: boolean } {
	const close = buffer.indexOf(closeTag);
	if (close === -1) {
		const hold = final ? 0 : partialSuffixOverlap(buffer, closeTag);
		section.delta(buffer.slice(0, buffer.length - hold), events);
		if (final) section.end(events);
		return { buffer: buffer.slice(buffer.length - hold), closed: final };
	}
	section.delta(buffer.slice(0, close), events);
	section.end(events);
	return { buffer: buffer.slice(close + closeTag.length), closed: true };
}

/**
 * The {@link scanThinkingText} step for a ` ```thinking ` section, whose close `fenced` matches
 * around nested code fences: the text `fenced` releases is streamed into `section`, which ends when
 * the closing fence arrives or the stream does. `closed` is true on either. The returned buffer is
 * the text after the closing fence, and empty while the section stays open, since `fenced` holds
 * any undecided tail itself.
 */
export function scanFencedThinking(
	fenced: FencedThinkingScanner,
	buffer: string,
	final: boolean,
	section: ThinkingSection,
	events: InbandScanEvent[],
): { buffer: string; closed: boolean } {
	const result = fenced.feed(buffer, final);
	section.delta(result.thinking, events);
	const closed = result.closed || final;
	if (closed) section.end(events);
	return { buffer: result.closed ? result.rest : "", closed };
}

/**
 * The body of a block that ends at a literal closer, such as a tool call's arguments, read across stream deltas. The
 * scanner passes its unread buffer to {@link read} on every step. The closer is searched for in that buffer alone,
 * and the part proven to precede the closer moves into {@link text}, so the buffer holds at most a closer prefix
 * between deltas. A string built with `+=` is flattened, a copy of the whole string, on its next read: a body kept in
 * the buffer and searched on every delta is copied on every delta, O(n·k) for n bytes in k deltas, where this is O(n).
 */
export class BlockBody {
	readonly #closer: string;
	#text = "";
	#added = "";
	#closed = false;
	/** Offset in {@link text} of the first closer occurrence `accepts` rejected, or -1. */
	#rejected = -1;

	constructor(closer: string) {
		this.#closer = closer;
	}

	/** Whether the block has closed: at its closer, or at the stream's end on the first closer it rejected. */
	get closed(): boolean {
		return this.#closed;
	}

	/** The body read so far; once {@link closed}, everything before the closer. */
	get text(): string {
		return this.#text;
	}

	/** The text the last {@link read} appended to {@link text}. */
	get added(): string {
		return this.#added;
	}

	/**
	 * Reads the scanner's unread buffer and returns what stays unread: the text after the closer once it arrives,
	 * otherwise a suffix that could begin the closer, held for the next delta, or nothing when `final` is set. A
	 * closer occurrence `accepts` rejects, given the body before it, is body text; when the stream ends with no
	 * accepted closer, the block closes at the first one rejected and the text after it is returned unread.
	 */
	read(buffer: string, final: boolean, accepts?: (before: string) => boolean): string {
		this.#added = "";
		const closer = this.#closer;
		let close = buffer.indexOf(closer);
		while (close !== -1 && accepts !== undefined && !accepts(this.#text + buffer.slice(0, close))) {
			if (this.#rejected === -1) this.#rejected = this.#text.length + close;
			close = buffer.indexOf(closer, close + 1);
		}
		if (close !== -1) {
			this.#append(buffer.slice(0, close));
			this.#closed = true;
			return buffer.slice(close + closer.length);
		}
		if (final && this.#rejected !== -1) {
			const read = this.#text + buffer;
			this.#text = read.slice(0, this.#rejected);
			this.#closed = true;
			return read.slice(this.#rejected + closer.length);
		}
		const keep = final ? buffer.length : buffer.length - partialSuffixOverlap(buffer, closer);
		this.#append(buffer.slice(0, keep));
		return buffer.slice(keep);
	}

	#append(text: string): void {
		this.#added = text;
		this.#text += text;
	}
}

export function normalizeKimiFunctionName(rawId: string): string {
	const beforeIndex = rawId.split(":", 1)[0] ?? rawId;
	const parts = beforeIndex.split(".");
	return parts[parts.length - 1]?.trim() ?? beforeIndex.trim();
}

/**
 * Coerce a parsed tool-argument value to a record, defaulting to an empty
 * object when it is not one. Tool-call `arguments` must always be a record, so
 * this never returns null. That is the opposite of the shared `asRecord` in
 * @veyyon/utils, which returns null for non-records; the distinct name keeps
 * the two contracts from being confused at a call site.
 */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

/** Decode a named call, including stringified arguments; malformed bodies use the scanner's partial-call recovery. */
export function parseNamedToolCall(body: string): Pick<ToolCall, "name" | "arguments"> | undefined {
	try {
		const parsed = parseJsonWithRepair<{ name?: unknown; arguments?: unknown }>(body.trim());
		if (typeof parsed.name !== "string" || parsed.name.length === 0) return undefined;
		let args = parsed.arguments;
		if (typeof args === "string") {
			args = parseJsonWithRepair<unknown>(args);
		}
		return { name: parsed.name, arguments: recordOrEmpty(args) };
	} catch {
		// The caller balances an announced toolStart with a best-effort toolEnd and retains the raw block.
		return undefined;
	}
}

/** Enough of a tool payload to recognize its shape in a log, without putting the whole thing there. */
function excerptArgs(text: string): string {
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Parse a tool call's raw `arguments` text into a record, reporting text that will not parse.
 *
 * Three streaming dialects (DeepSeek, Harmony, Kimi) and the GitLab Duo provider each had their own copy
 * of this, and each copy
 * caught the parse failure and returned `{}`. Empty is also what a call that legitimately takes no
 * arguments produces, so a model that emitted arguments the repair pass could not salvage had them
 * SILENTLY DROPPED: the tool then ran with no arguments at all, which is a different call from the one
 * the model made, and nothing in the transcript said so.
 *
 * Empty is still returned, because a dialect parser cannot abort a stream mid-tool-call and the tool's
 * own argument validation is the right place to refuse. What is new is that the loss is reported with
 * the source, the tool name, and a bounded excerpt of the text that would not parse, so the dropped
 * arguments can be told apart from a call that never had any.
 */
export function parseToolArgsText(raw: string, context: { source: string; tool?: string }): Record<string, unknown> {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = parseJsonWithRepair<unknown>(trimmed);
	} catch (error) {
		logger.warn("Tool call arguments could not be parsed; the tool is being called with none", {
			source: context.source,
			tool: context.tool,
			error: errorMessage(error),
			excerpt: excerptArgs(trimmed),
		});
		return {};
	}
	if (!isRecord(parsed)) {
		// Valid JSON that is not an object is the same silent loss by another route: a model that emitted a
		// bare string or an array had it turned into `{}` by `recordOrEmpty` with nothing said.
		logger.warn("Tool call arguments were not an object; the tool is being called with none", {
			source: context.source,
			tool: context.tool,
			received: Array.isArray(parsed) ? "array" : typeof parsed,
			excerpt: excerptArgs(trimmed),
		});
		return {};
	}
	return parsed;
}

/**
 * Assign a model-supplied tool-argument key/value safely. The JSON-body dialects
 * get their arguments from `JSON.parse`, which stores `__proto__` as an own data
 * property; the kv / streaming dialects build arguments key-by-key from model
 * output, so they route every model-controlled write through here to match that
 * behavior rather than diverging into prototype mutation. Thin tool-arg-named
 * wrapper over the shared {@link setSafeProperty}; see it for the hazard details.
 */
export function setToolArg(args: Record<string, unknown>, key: string, value: unknown): void {
	setSafeProperty(args, key, value);
}

/**
 * Read the OWN tool-argument stored under `key`, or `undefined` when there is
 * none, so accumulate-in-place parsers (array-valued keys, streaming value
 * growth) test their own prior write rather than an inherited built-in like
 * `Object.prototype`. Thin wrapper over the shared {@link getOwnProperty}.
 */
export function getOwnArg(args: Record<string, unknown>, key: string): unknown {
	return getOwnProperty(args, key);
}

/**
 * Complete an announced call with arguments recovered from a malformed body or, `unterminated`, from a
 * body the stream ended inside.
 */
export function emitBestEffortToolEnd(
	started: boolean,
	id: string,
	name: string,
	body: string,
	rawBlock: string,
	events: InbandScanEvent[],
	unterminated = false,
): void {
	if (!started) return;
	// A body that recovers to a non-object (`null`, a number) has no arguments to recover.
	const partial = recordOrEmpty(parseStreamingJson<unknown>(body));
	const end: InbandToolEnd = { type: "toolEnd", id, name, arguments: recordOrEmpty(partial.arguments), rawBlock };
	if (unterminated) end.unterminated = true;
	events.push(end);
}

/**
 * Complete a `<tool_call>` block whose closing tag arrived. A body that parses
 * ends the call it names, announcing it first when the streamed prefix never
 * did; a body that does not parse ends an announced call best-effort rather
 * than stranding it half open with the `{}` arguments seeded on `toolStart`.
 */
export function emitClosedToolCall(
	started: boolean,
	id: string,
	name: string,
	body: string,
	rawBlock: string,
	events: InbandScanEvent[],
): void {
	const parsed = parseNamedToolCall(body);
	if (!parsed) {
		emitBestEffortToolEnd(started, id, name, body, rawBlock, events);
		return;
	}
	if (!started) events.push({ type: "toolStart", id, name: parsed.name });
	events.push({ type: "toolEnd", id, name: parsed.name, arguments: parsed.arguments, rawBlock });
}
