import { errorMessage, getOwnProperty, isRecord, logger, parseJsonWithRepair, setSafeProperty } from "@veyyon/utils";
import { toolWireSchema } from "../utils/schema";
import type { InbandTool } from "./types";

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

export function partialSuffixOverlap(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let k = max; k > 0; k--) {
		if (text.endsWith(tag.slice(0, k))) return k;
	}
	return 0;
}

export function partialSuffixOverlapAny(text: string, tags: readonly string[]): number {
	let best = 0;
	for (const tag of tags) best = Math.max(best, partialSuffixOverlap(text, tag));
	return best;
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
