import { AI_PROMPTS } from "../prompts/registry";
import type { ToolCall } from "../types";
import {
	BlockBody,
	buildArgShapes,
	coerceValue,
	emitTextHoldingPartialTag,
	getArrayItemSchema,
	getObjectProperties,
	getOwnArg,
	isArraySchema,
	isObjectSchema,
	isStringOnlySchema,
	mintToolCallId,
	scanThinkingText,
	setToolArg,
	ThinkingSection,
	type ToolArgShape,
} from "./coercion";
import { chatMlTranscriptRenderer, renderThinkTags, renderToolResponseResults, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
	InbandToolEnd,
} from "./types";
import { THINK_CLOSE, THINK_OPEN } from "./wire-tags";

// Spec: docs/internal/toolconv/pi-native.md. Calls are `<call:NAME …>…</call:NAME>`
// blocks; arguments are attributes (scalars), child elements (anything), or a
// verbatim inline body (bulk string). Typing is schema-driven: string-typed
// values are verbatim, everything else JSON-coerces.

/**
 * Pi-native's own tags, prefixed with the dialect because `gemma.ts` used the bare `PI_CALL_OPEN` for a completely
 * different byte sequence. See the note in that file.
 */
const PI_CALL_OPEN = "<call:";
const PI_CALL_CLOSE_PREFIX = "</call:";
const OUTSIDE_TAGS = [PI_CALL_OPEN] as const;
const OUTSIDE_TAGS_THINK = [PI_CALL_OPEN, THINK_OPEN] as const;

type State = "outside" | "thinking" | "opentag" | "body";

interface OpenCall {
	id: string;
	name: string;
	closer: string;
	shape: ToolArgShape | undefined;
	attrs: Record<string, unknown>;
	/** The opening tag, which starts the call's raw block. */
	openTag: string;
	body: BlockBody;
	/** "unknown" until the first non-whitespace body content decides the shape. */
	bodyMode: "unknown" | "inline" | "elements";
	/** Target parameter the inline body fills; deltas stream against it. */
	inlineKey: string | null;
	/** Characters of the inline value streamed as arg deltas. */
	streamedInline: number;
	/** The inline value's text not yet streamed, a held trailing newline; undefined until streaming starts. */
	inlinePending: string | undefined;
}

class PiNativeInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#call: OpenCall | null = null;
	readonly #thinking = new ThinkingSection();
	#parseThinking: boolean;
	#shapes: Map<string, ToolArgShape>;
	/** {@link closerEndsBody} for the open call, made once so a body read allocates no predicate. */
	readonly #acceptsCloser = (before: string): boolean => closerEndsBody(this.#call!, before);

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking === true;
		this.#shapes = buildArgShapes(options.tools);
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
		let progressed = true;
		// The body state hands its text to the call's BlockBody, so the stream can end with the buffer empty inside a
		// body, which a closer the body already rejected may still close.
		while (progressed && (this.#buffer.length > 0 || (final && this.#state === "body"))) {
			progressed = false;
			if (this.#state === "outside") progressed = this.#consumeOutside(final, events);
			else if (this.#state === "thinking") progressed = this.#consumeThinking(final, events);
			else if (this.#state === "opentag") progressed = this.#consumeOpenTag(final, events);
			else progressed = this.#consumeBody(final, events);
		}
		if (final) {
			if (this.#state === "thinking") this.#endThinking(events);
			// The stream ended inside an announced call: it ends with the body read so far.
			if (this.#call) this.#endCall(this.#call, events, true);
			this.#state = "outside";
			this.#buffer = "";
		}
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const call = this.#buffer.indexOf(PI_CALL_OPEN);
		const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
		const start = call === -1 ? think : think === -1 ? call : Math.min(call, think);
		if (start === -1) {
			const tags = this.#parseThinking ? OUTSIDE_TAGS_THINK : OUTSIDE_TAGS;
			this.#buffer = emitTextHoldingPartialTag(this.#buffer, tags, final, events);
			return false;
		}
		if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
		if (start === think) {
			this.#buffer = this.#buffer.slice(start + THINK_OPEN.length);
			this.#thinking.start(events);
			this.#state = "thinking";
			return true;
		}
		this.#buffer = this.#buffer.slice(start);
		this.#state = "opentag";
		return true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): boolean {
		const { buffer, closed } = scanThinkingText(this.#buffer, THINK_CLOSE, final, this.#thinking, events);
		this.#buffer = buffer;
		if (closed) this.#state = "outside";
		return closed;
	}

	#endThinking(events: InbandScanEvent[]): void {
		this.#thinking.end(events);
		this.#state = "outside";
	}

	/** Consume the `<call:NAME attr…>` / `<call:NAME attr…/>` opening tag. */
	#consumeOpenTag(final: boolean, events: InbandScanEvent[]): boolean {
		const end = findTagEnd(this.#buffer);
		if (end === -1) {
			if (final) {
				// Malformed / truncated open tag at stream end: surface as text.
				events.push({ type: "text", text: this.#buffer });
				this.#buffer = "";
				this.#state = "outside";
			}
			return false;
		}
		const tag = this.#buffer.slice(0, end + 1);
		const parsed = parseOpenTag(tag);
		if (!parsed) {
			// Not a well-formed call tag (bad name): emit `<call:` as text and rescan.
			events.push({ type: "text", text: PI_CALL_OPEN });
			this.#buffer = this.#buffer.slice(PI_CALL_OPEN.length);
			this.#state = "outside";
			return true;
		}
		this.#buffer = this.#buffer.slice(end + 1);
		const id = mintToolCallId();
		const shape = this.#shapes.get(parsed.name);
		const attrs = coerceAttrs(parsed.attrs, shape?.properties);
		events.push({ type: "toolStart", id, name: parsed.name });
		if (parsed.selfClosing) {
			events.push({ type: "toolEnd", id, name: parsed.name, arguments: attrs, rawBlock: tag });
			this.#state = "outside";
			return true;
		}
		const closer = `${PI_CALL_CLOSE_PREFIX}${parsed.name}>`;
		this.#call = {
			id,
			name: parsed.name,
			closer,
			shape,
			attrs,
			openTag: tag,
			body: new BlockBody(closer),
			bodyMode: "unknown",
			inlineKey: inlineBodyKey(shape, attrs),
			streamedInline: 0,
			inlinePending: undefined,
		};
		this.#state = "body";
		return true;
	}

	/** Read the call body verbatim up to the call's own named closer. */
	#consumeBody(final: boolean, events: InbandScanEvent[]): boolean {
		const call = this.#call;
		if (!call) {
			this.#state = "outside";
			return true;
		}
		// Once the body is known to be inline, its first closer ends it; until then a closer is checked against the
		// body's form, since in element form the closer text may sit inside a string-typed child element.
		const accepts = call.bodyMode === "inline" ? undefined : this.#acceptsCloser;
		this.#buffer = call.body.read(this.#buffer, final, accepts);
		appendBody(call, events);
		if (!call.body.closed) return false;
		this.#endCall(call, events);
		return true;
	}

	#endCall(call: OpenCall, events: InbandScanEvent[], unterminated = false): void {
		const body = call.body.text;
		const args = finalizeCall(call, body);
		if (call.bodyMode === "inline" && call.inlineKey !== null) {
			// Flush the delta the trailing-newline holdback kept out of the stream.
			const value = typeof args[call.inlineKey] === "string" ? (args[call.inlineKey] as string) : "";
			const tail = value.slice(call.streamedInline);
			if (tail.length > 0) {
				events.push({ type: "toolArgDelta", id: call.id, name: call.name, key: call.inlineKey, delta: tail });
			}
		}
		const end: InbandToolEnd = {
			type: "toolEnd",
			id: call.id,
			name: call.name,
			arguments: args,
			rawBlock: unterminated ? `${call.openTag}${body}` : `${call.openTag}${body}${call.closer}`,
		};
		if (unterminated) end.unterminated = true;
		events.push(end);
		this.#call = null;
		this.#state = "outside";
	}
}

/**
 * Whether a closer occurrence ends the body before it. The body's form is settled from that text first, so a closer
 * that arrives in the same delta as the body's first child tag is checked as element form too; in element form the
 * closer counts only when everything before it parses as closed elements.
 */
function closerEndsBody(call: OpenCall, before: string): boolean {
	settleBodyMode(call, before);
	return call.bodyMode !== "elements" || elementsBodyClean(before);
}

/**
 * Decide an undecided body's form from its text: element form when its first non-whitespace content is a child tag,
 * otherwise the verbatim inline body (spec "Element form vs inline body"). `<` followed by a name char is the
 * child-tag signature. The body stays undecided while it holds only whitespace, or whitespace and a lone `<`.
 */
function settleBodyMode(call: OpenCall, text: string): void {
	if (call.bodyMode !== "unknown") return;
	const probe = text.replace(/^[\s]*/, "");
	if (probe.length === 0) return;
	if (probe[0] === "<") {
		if (probe.length < 2) return;
		call.bodyMode = /[A-Za-z_]/.test(probe[1]!) ? "elements" : "inline";
	} else {
		call.bodyMode = "inline";
	}
}

/** Settle the body's form from what the last read added, and stream an inline body's new text as arg deltas. */
function appendBody(call: OpenCall, events: InbandScanEvent[]): void {
	const added = call.body.added;
	if (added.length === 0) return;
	settleBodyMode(call, call.body.text);
	if (call.bodyMode !== "inline" || call.inlineKey === null) return;
	// Stream the verbatim body as arg deltas against the inline target
	// parameter, holding back the block-delimiter newlines: the leading
	// one is skipped, and a trailing one stays unstreamed until the next
	// chunk proves it is interior (the closer's newline is not value).
	let pending: string;
	if (call.inlinePending === undefined) {
		// The body was undecided until now, so it holds what arrived before this read too.
		const text = call.body.text;
		pending = text.startsWith("\n") ? text.slice(1) : text;
	} else {
		pending = call.inlinePending + added;
	}
	const streamEnd = pending.endsWith("\n") ? pending.length - 1 : pending.length;
	if (streamEnd > 0) {
		events.push({
			type: "toolArgDelta",
			id: call.id,
			name: call.name,
			key: call.inlineKey,
			delta: pending.slice(0, streamEnd),
		});
		call.streamedInline += streamEnd;
		pending = pending.slice(streamEnd);
	}
	call.inlinePending = pending;
}

/** Index of the unquoted `>` ending an open tag, or -1 while incomplete. */
function findTagEnd(text: string): number {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ">") return i;
	}
	return -1;
}

interface RawAttr {
	key: string;
	/** null for a bare attribute (boolean true). */
	value: string | null;
	quoted: boolean;
}

interface ParsedOpenTag {
	name: string;
	attrs: RawAttr[];
	selfClosing: boolean;
}

/** Parse `<call:NAME attr…>` / `<call:NAME attr…/>`; null when malformed. */
function parseOpenTag(tag: string): ParsedOpenTag | null {
	if (!tag.startsWith(PI_CALL_OPEN) || !tag.endsWith(">")) return null;
	let inner = tag.slice(PI_CALL_OPEN.length, -1);
	const selfClosing = inner.endsWith("/");
	if (selfClosing) inner = inner.slice(0, -1);
	const nameMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(inner);
	if (!nameMatch) return null;
	const name = nameMatch[0];
	const attrs = parseAttrs(inner.slice(name.length));
	if (attrs === null) return null;
	return { name, attrs, selfClosing };
}

/** Tokenize `KEY="…"` / `KEY='…'` / `KEY=bare` / bare `KEY` attributes. */
function parseAttrs(text: string): RawAttr[] | null {
	const attrs: RawAttr[] = [];
	let i = 0;
	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i]!)) i++;
		if (i >= text.length) break;
		const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
		if (!keyMatch) return null;
		const key = keyMatch[0];
		i += key.length;
		let j = i;
		while (j < text.length && /\s/.test(text[j]!)) j++;
		if (j >= text.length || text[j] !== "=") {
			attrs.push({ key, value: null, quoted: false });
			continue;
		}
		i = j + 1;
		while (i < text.length && /\s/.test(text[i]!)) i++;
		const open = text[i];
		if (open === '"' || open === "'") {
			const close = text.indexOf(open, i + 1);
			if (close === -1) return null;
			attrs.push({ key, value: text.slice(i + 1, close), quoted: true });
			i = close + 1;
			continue;
		}
		let end = i;
		while (end < text.length && !/\s/.test(text[end]!)) end++;
		attrs.push({ key, value: text.slice(i, end), quoted: false });
		i = end;
	}
	return attrs;
}

/** Coerce raw attributes by each property's schema (quotes are delimiters, not types). */
function coerceAttrs(
	attrs: readonly RawAttr[],
	properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const attr of attrs) {
		if (attr.value === null) {
			setToolArg(out, attr.key, true);
			continue;
		}
		setToolArg(out, attr.key, coerceValue(attr.value, properties?.[attr.key]));
	}
	return out;
}

/**
 * The parameter a verbatim inline body would fill: the first schema parameter
 * not already supplied as an attribute, when that parameter is string-typed.
 * Null when the tool is unknown or the target is not a string.
 */
function inlineBodyKey(shape: ToolArgShape | undefined, attrs: Record<string, unknown>): string | null {
	if (!shape) return null;
	for (const key of shape.parameterOrder) {
		if (key in attrs) continue;
		return isStringOnlySchema(shape.properties[key]) ? key : null;
	}
	return null;
}

/** Strip the single leading/trailing block-delimiter newline from a body. */
function stripBlockNewlines(text: string): string {
	let out = text;
	if (out.startsWith("\n")) out = out.slice(1);
	if (out.endsWith("\n")) out = out.slice(0, -1);
	return out;
}

function finalizeCall(call: OpenCall, body: string): Record<string, unknown> {
	const args: Record<string, unknown> = { ...call.attrs };
	if (call.bodyMode === "elements") {
		const members = parseMembers(body, call.shape?.properties);
		for (const key of Object.keys(members)) setToolArg(args, key, getOwnArg(members, key));
		return args;
	}
	// Inline body (or an all-whitespace body, which contributes nothing).
	const value = stripBlockNewlines(body);
	if (call.bodyMode === "unknown" || (call.bodyMode === "inline" && value.length === 0 && call.inlineKey === null)) {
		return args;
	}
	if (call.inlineKey !== null) {
		args[call.inlineKey] = value;
		return args;
	}
	// No schema for this tool: fall back to the conventional single parameter.
	if (value.length > 0) args.input = value;
	return args;
}

interface ParsedElement {
	name: string;
	value: unknown;
}

/**
 * Fold a flat list of parsed sibling elements into an arguments record. Repeated
 * sibling names collapse into an array; a name whose schema is array-typed is an
 * array even with a single occurrence; every other name keeps its scalar value.
 * Model-supplied names route through {@link setToolArg}/{@link getOwnArg} so a
 * literal `__proto__` (or `constructor`/`prototype`) lands as a safe own property
 * instead of mutating the record's prototype. This is the single owner of the
 * fold rule; both the top-level body parser and the nested-object parser use it.
 */
function foldParsedElements(
	entries: readonly ParsedElement[],
	properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
	for (const entry of entries) {
		const schema = properties?.[entry.name];
		const isArray = schema !== undefined ? isArraySchema(schema) : (counts.get(entry.name) ?? 0) >= 2;
		if (isArray) {
			const existing = getOwnArg(out, entry.name);
			if (Array.isArray(existing)) existing.push(entry.value);
			else setToolArg(out, entry.name, [entry.value]);
		} else {
			setToolArg(out, entry.name, entry.value);
		}
	}
	return out;
}

/**
 * Recursive element-form parser (runs on the complete body at call close).
 * Repeated sibling names fold into arrays; schema-typed arrays are arrays even
 * with one occurrence; scalar bodies coerce by the parameter's schema type.
 */
function parseMembers(text: string, properties: Record<string, unknown> | undefined): Record<string, unknown> {
	const entries: ParsedElement[] = [];
	let pos = 0;
	while (pos < text.length) {
		while (pos < text.length && /\s/.test(text[pos]!)) pos++;
		if (pos >= text.length) break;
		const parsed = parseElementAt(text, pos, properties);
		if (!parsed) break;
		entries.push({ name: parsed.name, value: parsed.value });
		pos = parsed.end;
	}
	return foldParsedElements(entries, properties);
}

interface ElementParse {
	name: string;
	value: unknown;
	end: number;
}

function parseElementAt(
	text: string,
	start: number,
	properties: Record<string, unknown> | undefined,
): ElementParse | null {
	if (text[start] !== "<") return null;
	const tagEnd = findTagEnd(text.slice(start));
	if (tagEnd === -1) return null;
	const tag = text.slice(start, start + tagEnd + 1);
	let inner = tag.slice(1, -1);
	const selfClosing = inner.endsWith("/");
	if (selfClosing) inner = inner.slice(0, -1);
	const nameMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(inner);
	if (!nameMatch) return null;
	const name = nameMatch[0];
	const attrs = parseAttrs(inner.slice(name.length));
	if (attrs === null) return null;
	let schema = properties?.[name];
	// Array-typed fields parse each occurrence as the item type.
	if (schema !== undefined && isArraySchema(schema)) schema = getArrayItemSchema(schema);
	const childProps = schema !== undefined ? getObjectProperties(schema) : undefined;
	const coercedAttrs = coerceAttrs(attrs, childProps);

	if (selfClosing) {
		// Object via attrs, or an empty value.
		if (attrs.length > 0 || (schema !== undefined && isObjectSchema(schema)))
			return { name, value: coercedAttrs, end: start + tagEnd + 1 };
		if (schema !== undefined && isStringOnlySchema(schema)) return { name, value: "", end: start + tagEnd + 1 };
		return { name, value: schema === undefined ? "" : coerceValue("", schema), end: start + tagEnd + 1 };
	}

	const closer = `</${name}>`;
	const bodyStart = start + tagEnd + 1;

	const objectLike =
		schema !== undefined
			? isObjectSchema(schema)
			: attrs.length > 0 || bodyStartsWithChildTag(text, bodyStart, closer);
	if (objectLike) {
		// Recursive descent consumes child tags, so nesting closes correctly.
		const members = parseObjectBody(text, bodyStart, name, childProps);
		if (!members) return null;
		return { name, value: { ...coercedAttrs, ...members.value }, end: members.end };
	}

	// Scalar/string body: verbatim up to the first matching closer.
	const close = text.indexOf(closer, bodyStart);
	if (close === -1) return null;
	const raw = stripBlockNewlines(text.slice(bodyStart, close));
	return { name, value: coerceValue(raw, schema), end: close + closer.length };
}

/** Whether a body parses as a run of fully closed elements (validates closer candidates in element form). */
function elementsBodyClean(text: string): boolean {
	let pos = 0;
	while (pos < text.length) {
		while (pos < text.length && /\s/.test(text[pos]!)) pos++;
		if (pos >= text.length) break;
		const parsed = parseElementAt(text, pos, undefined);
		if (!parsed) return false;
		pos = parsed.end;
	}
	return true;
}

/** Whether a block body's first non-whitespace content is a child tag (heuristic for no-schema object detection). */
function bodyStartsWithChildTag(text: string, from: number, closer: string): boolean {
	let i = from;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (text.startsWith(closer, i)) return false;
	return text[i] === "<" && i + 1 < text.length && /[A-Za-z_]/.test(text[i + 1]!);
}

function parseObjectBody(
	text: string,
	from: number,
	name: string,
	properties: Record<string, unknown> | undefined,
): { value: Record<string, unknown>; end: number } | null {
	const closer = `</${name}>`;
	const entries: ParsedElement[] = [];
	let pos = from;
	while (pos < text.length) {
		while (pos < text.length && /\s/.test(text[pos]!)) pos++;
		if (text.startsWith(closer, pos)) {
			return { value: foldParsedElements(entries, properties), end: pos + closer.length };
		}
		if (pos >= text.length) break;
		const parsed = parseElementAt(text, pos, properties);
		if (!parsed) return null;
		entries.push({ name: parsed.name, value: parsed.value });
		pos = parsed.end;
	}
	return null;
}

// ---- rendering ----

/** True when the value renders safely inside a double-quoted attribute. */
function attrSafe(value: unknown): boolean {
	if (typeof value === "string") return !value.includes('"') && !value.includes("\n") && !value.includes(">");
	return value === null || typeof value === "number" || typeof value === "boolean";
}

function renderAttrValue(value: unknown, isString: boolean): string {
	if (isString && typeof value === "string") return `"${value}"`;
	return typeof value === "string" ? `"${value}"` : stringifyJson(value);
}

function renderElement(name: string, value: unknown, schema: unknown, indent: string): string {
	if (Array.isArray(value)) {
		const itemSchema = getArrayItemSchema(schema);
		return value.map(item => renderElement(name, item, itemSchema, indent)).join("\n");
	}
	if (value !== null && typeof value === "object") {
		const props = getObjectProperties(schema);
		const record = value as Record<string, unknown>;
		const children = Object.keys(record)
			.map(key => renderElement(key, record[key], props[key], indent))
			.join("\n");
		if (children.length === 0) return `${indent}<${name}/>`;
		return `${indent}<${name}>\n${children}\n${indent}</${name}>`;
	}
	if (typeof value === "string" && (schema === undefined ? true : isStringOnlySchema(schema))) {
		// String-typed values are verbatim; multi-line bodies keep the newline
		// block delimiters.
		return value.includes("\n")
			? `${indent}<${name}>\n${value}\n${indent.length > 0 ? indent : ""}</${name}>`
			: `${indent}<${name}>${value}</${name}>`;
	}
	return `${indent}<${name}>${stringifyJson(value)}</${name}>`;
}

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	const shape = buildArgShapes(options.tools).get(call.name);
	return piNativeInvocation(call, shape);
}

function piNativeInvocation(call: ToolCall, shape: ToolArgShape | undefined): string {
	const args = call.arguments;
	const keys = Object.keys(args);
	const closer = `${PI_CALL_CLOSE_PREFIX}${call.name}>`;

	if (shape) {
		// Inline-body form: every parameter is string-typed, the bulk value goes
		// verbatim in the body, remaining string scalars ride as attributes.
		const allString = shape.parameterOrder.length > 0 && shape.parameterOrder.every(key => shape.stringArgs.has(key));
		if (allString && keys.length > 0 && keys.every(key => typeof args[key] === "string")) {
			let bulk: string | null = null;
			for (const key of keys) {
				const value = args[key] as string;
				if (bulk === null || value.length > (args[bulk] as string).length) bulk = key;
			}
			const bulkValue = args[bulk!] as string;
			const others = keys.filter(key => key !== bulk);
			const inlineTarget = shape.parameterOrder.find(key => !others.includes(key));
			if (inlineTarget === bulk && !bulkValue.includes(closer) && others.every(key => attrSafe(args[key]))) {
				const attrText = others.map(key => ` ${key}=${renderAttrValue(args[key], true)}`).join("");
				return `${PI_CALL_OPEN}${call.name}${attrText}>\n${bulkValue}\n${closer}`;
			}
		}
		// Attribute form: all-scalar arguments collapse onto a self-closing tag.
		if (keys.length > 0 && keys.every(key => attrSafe(args[key]))) {
			const attrText = keys.map(key => ` ${key}=${renderAttrValue(args[key], shape.stringArgs.has(key))}`).join("");
			return `${PI_CALL_OPEN}${call.name}${attrText}/>`;
		}
	}

	// Element form (canonical, fully general).
	if (keys.length === 0) return `${PI_CALL_OPEN}${call.name}/>`;
	const children = keys.map(key => renderElement(key, args[key], shape?.properties[key], "")).join("\n");
	return `${PI_CALL_OPEN}${call.name}>\n${children}\n${closer}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	const shapes = buildArgShapes(options.tools);
	return calls.map(call => piNativeInvocation(call, shapes.get(call.name))).join("\n");
}

const definition: DialectDefinition = {
	dialect: "pi-native",
	prompt: AI_PROMPTS["dialect/pi-native"].text,
	createScanner: options => new PiNativeInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderThinkTags,
	renderTranscript: chatMlTranscriptRenderer({
		toolResultRole: "tool",
		renderThinking: renderThinkTags,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResponseResults,
	}),
};

export default definition;
