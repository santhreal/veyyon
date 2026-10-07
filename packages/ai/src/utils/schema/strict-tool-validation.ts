import { isRecord } from "@veyyon/utils/type-guards";

/**
 * Detects tool-parameter schemas that pass structural JSON-Schema validation
 * (so {@link isValidJsonSchema} accepts them) yet make OpenAI-style providers
 * reject the whole request with HTTP 400 — namely an `enum`/`const` whose
 * value(s) cannot satisfy the node's declared `type`. MCP servers emit these
 * when a nullable/array branch is built incorrectly (e.g. a non-null `enum`
 * copied onto a `type: "null"` branch, or an `enum` placed on an `array`
 * schema instead of its `items`). One such tool 400s the entire turn, so
 * callers quarantine just the offending tool. See issue #2652.
 */

type JsonRecord = Record<string, unknown>;

const SCHEMA_TYPE_NAMES: Record<string, true> = {
	string: true,
	number: true,
	integer: true,
	boolean: true,
	object: true,
	array: true,
	null: true,
};

function jsonValueMatchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		default:
			// Unknown type keyword — don't flag (forward compatibility).
			return true;
	}
}

function declaredTypes(node: JsonRecord): string[] {
	const t = node.type;
	if (typeof t === "string") return t in SCHEMA_TYPE_NAMES ? [t] : [];
	if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string" && x in SCHEMA_TYPE_NAMES);
	return [];
}

const CHILD_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const CHILD_SCHEMA_KEYS = [
	"items",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"propertyNames",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
] as const;
const CHILD_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/**
 * Walk a tool parameter schema for OpenAI-strict `enum`/`const`-vs-`type`
 * contradictions. Returns a JSON-pointer-ish path to the first offending node,
 * or `null` when the schema is safe to emit.
 */
export function findStrictToolSchemaViolation(schema: unknown, path = "#"): string | null {
	const suffix = findViolation(schema);
	return suffix === null ? null : `${path}${suffix}`;
}

/**
 * The path from `schema` to its first offending node, or null. The path is assembled on the way back out of a
 * hit, so a schema with no violation builds no path strings.
 */
function findViolation(schema: unknown): string | null {
	if (Array.isArray(schema)) return findInSchemaArray(schema);
	if (typeof schema !== "object" || schema === null) return null;
	const node = schema as JsonRecord;
	return findTypeContradiction(node) ?? findInSchemaMaps(node) ?? findInChildSchemas(node);
}

/** `/enum` or `/const` when a value of that keyword contradicts every declared `type`, else null. */
function findTypeContradiction(node: JsonRecord): string | null {
	const types = declaredTypes(node);
	if (types.length === 0) return null;
	if (Array.isArray(node.enum) && node.enum.some(value => !types.some(type => jsonValueMatchesType(value, type)))) {
		return "/enum";
	}
	if ("const" in node && !types.some(type => jsonValueMatchesType(node.const, type))) return "/const";
	return null;
}

function findInSchemaArray(schemas: readonly unknown[]): string | null {
	for (let i = 0; i < schemas.length; i++) {
		const hit = findViolation(schemas[i]);
		if (hit !== null) return `/${i}${hit}`;
	}
	return null;
}

/** Searches each entry of the node's schema maps (`properties`, `$defs`, …). */
function findInSchemaMaps(node: JsonRecord): string | null {
	for (const key of CHILD_MAP_KEYS) {
		const sub = node[key];
		if (!isRecord(sub)) continue;
		for (const name in sub) {
			const hit = findViolation(sub[name]);
			if (hit !== null) return `/${key}/${name}${hit}`;
		}
	}
	return null;
}

/** Searches the node's single-schema keywords, then its schema-array keywords. */
function findInChildSchemas(node: JsonRecord): string | null {
	for (const key of CHILD_SCHEMA_KEYS) {
		const hit = key in node ? findViolation(node[key]) : null;
		if (hit !== null) return `/${key}${hit}`;
	}
	for (const key of CHILD_ARRAY_KEYS) {
		const schemas = node[key];
		const hit = Array.isArray(schemas) ? findInSchemaArray(schemas) : null;
		if (hit !== null) return `/${key}${hit}`;
	}
	return null;
}
