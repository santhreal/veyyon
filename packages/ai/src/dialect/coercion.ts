import { isRecord } from "@veyyon/utils";
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

/**
 * Argument names that a plain `obj[key] = value` assignment does NOT store as a
 * normal own property. `__proto__` routes through `Object.prototype`'s accessor:
 * an object value silently REPLACES the object's prototype (so the argument
 * vanishes and its fields leak in as phantom inherited members) and a string
 * value is dropped entirely. `constructor`/`prototype` are included so a
 * model-supplied key can never shadow those built-ins either.
 *
 * These names are never assigned literally by the JSON-body dialects, whose
 * arguments come from `JSON.parse` (which stores `__proto__` as a safe own data
 * property). The kv / streaming dialects build arguments key-by-key from model
 * output, so they MUST route every model-controlled write through
 * {@link setToolArg} to match that safe behavior rather than diverging into
 * prototype mutation.
 */
const UNSAFE_ARG_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Assign `value` onto tool-call `args` under a model-supplied `key`, storing it
 * as a normal own, enumerable property even when `key` is one of
 * {@link UNSAFE_ARG_KEYS}. For those keys it uses `Object.defineProperty` so the
 * value lands as an own data property under the literal name — byte-identical to
 * how `JSON.parse` (and thus the JSON-body dialects) represents the same key —
 * instead of hitting the prototype setter. Ordinary keys take the plain fast
 * path, so this adds only a set membership test on the hot parse path.
 */
export function setToolArg(args: Record<string, unknown>, key: string, value: unknown): void {
	if (UNSAFE_ARG_KEYS.has(key)) {
		Object.defineProperty(args, key, { value, writable: true, enumerable: true, configurable: true });
		return;
	}
	args[key] = value;
}

/**
 * Read the OWN tool-argument stored under `key`, or `undefined` when there is
 * none. A bare `args[key]` read for `key === "__proto__"` returns the inherited
 * `Object.prototype` (never the caller's intent) even before anything is stored;
 * this returns the own value {@link setToolArg} wrote, or `undefined`, so
 * accumulate-in-place parsers (array-valued keys, streaming value growth) test
 * their own prior write rather than an inherited built-in.
 */
export function getOwnArg(args: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(args, key) ? args[key] : undefined;
}
