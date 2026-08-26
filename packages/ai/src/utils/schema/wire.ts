/**
 * Compute the wire (JSON Schema) representation of a tool's parameters.
 * Normalizes Zod, ArkType, and raw JSON Schema into the expected dialect.
 */

import { isRecord } from "@veyyon/utils/type-guards";
import type { ArkErrors, Type } from "arktype";
// We import the Zod *value* (z) for runtime APIs. Marker checks rely on the
// `_zod` symbol that every Zod v4 schema instance carries.
import { type ZodType, z } from "zod/v4";
import type { Tool, TSchema } from "../../types";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { stamp } from "./stamps";

/**
 * True when `value` is a live Zod schema instance carrying prototype methods.
 * Stricter than `_zod` property check to avoid impostors from serialized JSON.
 */
export function isZodSchema(value: unknown): value is ZodType {
	return (
		typeof value === "object" &&
		value !== null &&
		// Zod v4 instances expose a `_zod` internal property with a `def` object.
		// Tagging on this marker keeps the check stable across Zod minor versions.
		// (`_zod` is part of Zod's documented internal contract used by introspection.)
		// We avoid checking constructor name because Zod ships multiple variants
		// (`ZodObject`, `ZodOptional`, etc.) and a tagged-union style check would
		// have to enumerate them all.
		"_zod" in value &&
		typeof (value as { _zod?: { def?: unknown } })._zod === "object" &&
		// Reject JSON-roundtripped objects that kept the `_zod` key but lost the
		// prototype. Real instances have `.parse` on the prototype chain.
		typeof (value as { parse?: unknown }).parse === "function"
	);
}

/**
 * True when `value` is a live ArkType schema instance with `toJsonSchema`/`assert`.
 */
export function isArkSchema(value: unknown): value is Type {
	return (
		typeof value === "function" &&
		typeof (value as { toJsonSchema?: unknown }).toJsonSchema === "function" &&
		typeof (value as { assert?: unknown }).assert === "function"
	);
}

/**
 * True when `value` is an ArkType rejection (`ArkErrors` array with `summary`).
 * Avoids costly module evaluation from importing ArkType's `type.errors`.
 */
export function isArkErrors(value: unknown): value is ArkErrors {
	return Array.isArray(value) && typeof (value as { summary?: unknown }).summary === "string";
}

function isArkJsonAst(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(isArkJsonAst);
	if (!isRecord(value)) return false;
	if (typeof value.domain === "string" || Object.hasOwn(value, "unit")) return true;
	if (value.proto === "Array" && Object.hasOwn(value, "sequence")) return true;
	const required = value.required;
	return (
		Array.isArray(required) &&
		required.some(entry => isRecord(entry) && typeof entry.key === "string" && "value" in entry)
	);
}

function parseArkObjectKey(key: string): { name: string; description?: string } {
	const match = /^(.*?)\s*\/\*\*\s*([\s\S]*?)\s*\*\/\s*$/.exec(key);
	if (!match) return { name: key };
	return { name: match[1].trim(), description: match[2].trim() };
}

function withArkKeyDescription(schema: unknown, description: string | undefined): unknown {
	if (!description) return schema;
	if (isRecord(schema)) {
		if (typeof schema.description !== "string") schema.description = description;
		return schema;
	}
	return { anyOf: [schema], description };
}

function arkJsonAstToWire(value: unknown): unknown {
	if (typeof value === "string") {
		switch (value) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "object":
				return { type: value };
			case "unknown":
				return {};
			default:
				return {};
		}
	}

	if (Array.isArray(value)) {
		if (value.every(item => isRecord(item) && Object.hasOwn(item, "unit"))) {
			return { enum: value.map(item => (item as { unit: unknown }).unit) };
		}
		return { anyOf: value.map(arkJsonAstToWire) };
	}

	if (!isRecord(value)) return {};

	if (Object.hasOwn(value, "unit")) return { const: value.unit };

	if (value.proto === "Array" && Object.hasOwn(value, "sequence")) {
		return { type: "array", items: arkJsonAstToWire(value.sequence) };
	}

	if (value.domain === "object") {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		const addEntry = (entry: unknown, isRequired: boolean): void => {
			if (!isRecord(entry) || typeof entry.key !== "string" || !("value" in entry)) return;
			const key = parseArkObjectKey(entry.key);
			properties[key.name] = withArkKeyDescription(arkJsonAstToWire(entry.value), key.description);
			if (isRequired) required.push(key.name);
		};
		if (Array.isArray(value.required)) {
			for (const entry of value.required) addEntry(entry, true);
		}
		if (Array.isArray(value.optional)) {
			for (const entry of value.optional) addEntry(entry, false);
		}
		const schema: Record<string, unknown> = { type: "object", properties };
		if (required.length > 0) schema.required = required;
		return schema;
	}

	if (typeof value.domain === "string") return { type: value.domain };
	return {};
}

/** Symbol-stamped caches keyed by schema object identity. */
const kZodWireSchema = Symbol("pi.schema.zod.wire");
const kJsonWireSchema = Symbol("pi.schema.json.wire");
const kArkWireSchema = Symbol("pi.schema.ark.wire");
const kStrippedSchema = Symbol("pi.schema.descriptions.stripped");

/**
 * Post-process Zod-emitted JSON Schema to match provider expectations:
 * drops `$schema`, makes defaulted fields optional, and strips safe-int bounds.
 */
function postProcess(schema: Record<string, unknown>): Record<string, unknown> {
	delete schema.$schema;
	walk(schema, true);
	normalizeArkPropertyComments(schema);
	normalizeEmptySchemas(schema);
	return schema;
}

function postProcessJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	walk(schema, false);
	normalizeArkPropertyComments(schema);
	normalizeEmptySchemas(schema);
	return schema;
}

const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_INTEGER_MIN = Number.MIN_SAFE_INTEGER;
const NULLABLE_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

const SCHEMA_DEFINING_SIBLING_KEYS = new Set([
	"$ref",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"enum",
	"if",
	"items",
	"not",
	"oneOf",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

function hasSchemaDefiningSibling(schema: Record<string, unknown>): boolean {
	for (const key in schema) {
		if (key !== "anyOf" && SCHEMA_DEFINING_SIBLING_KEYS.has(key)) return true;
	}
	return false;
}

function isNullVariant(schema: Record<string, unknown>): boolean {
	return schema.type === "null" && Object.keys(schema).length === 1;
}

function isScalarVariant(schema: Record<string, unknown>): schema is Record<string, unknown> & { type: string } {
	return typeof schema.type === "string" && NULLABLE_SCALAR_TYPES.has(schema.type);
}

function hasIntegerType(type: unknown): boolean {
	return type === "integer" || (Array.isArray(type) && type.includes("integer"));
}

function copyNullableScalarConstraints(schema: Record<string, unknown>, scalarVariant: Record<string, unknown>): void {
	for (const key in scalarVariant) {
		if (key === "type" || key === "enum" || key === "const" || Object.hasOwn(schema, key)) continue;
		schema[key] = scalarVariant[key];
	}

	if (Object.hasOwn(scalarVariant, "const")) {
		schema.enum = [scalarVariant.const, null];
		return;
	}

	const enumValues = scalarVariant.enum;
	if (Array.isArray(enumValues)) {
		schema.enum = enumValues.includes(null) ? enumValues : [...enumValues, null];
	}
}

function rewriteNullableScalarAnyOf(schema: Record<string, unknown>): void {
	if (hasSchemaDefiningSibling(schema)) return;
	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length !== 2) return;

	let scalarVariant: Record<string, unknown> | undefined;
	let scalarType: string | undefined;
	let sawNull = false;
	for (const variant of variants) {
		if (!isRecord(variant)) return;
		if (isNullVariant(variant)) {
			if (sawNull) return;
			sawNull = true;
			continue;
		}
		if (!isScalarVariant(variant) || scalarVariant) return;
		scalarVariant = variant;
		scalarType = variant.type;
	}
	if (!sawNull || !scalarVariant || !scalarType) return;

	delete schema.anyOf;
	copyNullableScalarConstraints(schema, scalarVariant);
	schema.type = [scalarType, "null"];
}

/** Keys whose values are a single JSON Schema (not an array or map). */
const SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
] as const;

/** Keys whose values are a map of `{ key: Schema }` entries. */
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/** Keys whose values are an array of schemas. */
const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

function normalizeArkPropertyComments(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeArkPropertyComments(child);
		return;
	}
	if (!isRecord(node)) return;
	const obj = node as Record<string, unknown>;

	const properties = obj.properties;
	if (isRecord(properties)) {
		const required = Array.isArray(obj.required) ? obj.required : undefined;
		if (required) {
			obj.required = required.map(key => (typeof key === "string" ? parseArkObjectKey(key).name : key));
		}
		for (const key of Object.keys(properties)) {
			const parsed = parseArkObjectKey(key);
			const targetKey = parsed.name;
			let propertySchema = properties[key];
			if (parsed.description) {
				propertySchema = withArkKeyDescription(propertySchema, parsed.description);
				delete properties[key];
				properties[targetKey] = propertySchema;
			}
			normalizeArkPropertyComments(propertySchema);
		}
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) normalizeArkPropertyComments(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		if (mapKey === "properties") continue;
		const map = obj[mapKey];
		if (isRecord(map)) {
			for (const key in map) normalizeArkPropertyComments(map[key]);
		}
	}
	for (const arrayKey of SCHEMA_ARRAY_KEYS) {
		const array = obj[arrayKey];
		if (Array.isArray(array)) {
			for (const child of array) normalizeArkPropertyComments(child);
		}
	}
}

/** True when `val` is a plain empty object `{}`. */
function isEmptyObject(val: unknown): val is Record<string, never> {
	if (!isRecord(val)) return false;
	return Object.keys(val).length === 0;
}

/**
 * The single JSON Schema scalar `type` that describes every member of a
 * homogeneous primitive enum, or `undefined` when the members are mixed,
 * non-scalar (`null`/object/array), or the list is empty.
 */
function homogeneousEnumScalarType(values: readonly unknown[]): string | undefined {
	if (values.length === 0) return undefined;
	let inferred: string | undefined;
	for (const value of values) {
		let scalar: string | undefined;
		switch (typeof value) {
			case "string":
				scalar = "string";
				break;
			case "boolean":
				scalar = "boolean";
				break;
			case "number":
				scalar = "number";
				break;
			default:
				return undefined; // null / object / array — not a single scalar type
		}
		if (inferred === undefined) inferred = scalar;
		else if (inferred !== scalar) return undefined; // mixed primitives
	}
	return inferred;
}

/**
 * Infer scalar `type` for bare `{ enum: [...] }` unions to satisfy Gemini/Vertex
 * requirements when every member shares a common scalar type.
 */
function inferBareEnumScalarType(obj: Record<string, unknown>): void {
	if ("type" in obj || !Array.isArray(obj.enum)) return;
	const inferred = homogeneousEnumScalarType(obj.enum);
	if (inferred !== undefined) obj.type = inferred;
}

/**
 * Collapse homogeneous all-`const` literal unions into a typed `{ type, enum, description }`
 * node when lossless, avoiding duplicated descriptions across branches.
 */
function collapseConstUnionAnyOf(obj: Record<string, unknown>): void {
	// `hasSchemaDefiningSibling` already rejects a sibling `enum`/`const`/etc.; it
	// does not list `type`, so guard it here — collapsing would overwrite a
	// wrapper `type` constraint paired with the `anyOf`.
	if (hasSchemaDefiningSibling(obj) || "type" in obj) return;
	const variants = obj.anyOf;
	if (!Array.isArray(variants) || variants.length < 2) return;

	const values: unknown[] = [];
	let branchDescription: string | undefined;
	let describedCount = 0;
	for (const variant of variants) {
		if (!isRecord(variant) || !Object.hasOwn(variant, "const")) return;
		for (const key in variant) {
			if (key !== "const" && key !== "description") return; // extra constraints — not a bare const
		}
		const desc = variant.description;
		if (typeof desc === "string") {
			if (describedCount === 0) branchDescription = desc;
			else if (desc !== branchDescription) return; // distinct per-variant descriptions — preserve them
			describedCount++;
		}
		values.push(variant.const);
	}
	if (describedCount !== 0 && describedCount !== variants.length) return; // mixed described/undescribed
	// A shared branch description that disagrees with the union root's own
	// description would be silently dropped by the collapse — keep the anyOf so
	// neither annotation is lost. (Equal descriptions, the ArkType case, collapse.)
	if (
		describedCount === variants.length &&
		typeof obj.description === "string" &&
		obj.description !== branchDescription
	) {
		return;
	}

	const scalarType = homogeneousEnumScalarType(values);
	if (scalarType === undefined) return; // mixed / non-scalar (incl. null) — leave as anyOf

	delete obj.anyOf;
	obj.type = scalarType;
	obj.enum = values;
	if (typeof obj.description !== "string" && branchDescription !== undefined) {
		obj.description = branchDescription;
	}
}

function walk(node: unknown, zodCleanup: boolean): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, zodCleanup);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	rewriteNullableScalarAnyOf(obj);
	inferBareEnumScalarType(obj);
	collapseConstUnionAnyOf(obj);

	if (zodCleanup) {
		// Drop noise injected for `z.number().int()`.
		if (hasIntegerType(obj.type)) {
			if (obj.minimum === SAFE_INTEGER_MIN) delete obj.minimum;
			if (obj.maximum === SAFE_INTEGER_MAX) delete obj.maximum;
		}

		// Make defaulted properties non-required.
		if (Array.isArray(obj.required) && obj.properties && typeof obj.properties === "object") {
			const properties = obj.properties as Record<string, unknown>;
			const required = obj.required as string[];
			const filtered = required.filter(name => {
				const propertySchema = properties[name];
				if (!propertySchema || typeof propertySchema !== "object") return true;
				return !("default" in (propertySchema as Record<string, unknown>));
			});
			if (filtered.length !== required.length) {
				if (filtered.length === 0) {
					delete obj.required;
				} else {
					obj.required = filtered;
				}
			}
		}
	}

	for (const k in obj) walk(obj[k], zodCleanup);
}

/**
 * Normalize `{}` (empty schema = `z.unknown()`) to boolean `true` in all schema positions
 * so grammar-constrained samplers treat it as unconstrained rather than an empty object.
 */
export function normalizeEmptySchemas(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeEmptySchemas(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key) && isEmptyObject(obj[key])) obj[key] = true;
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (isRecord(map)) {
			for (const k in map as Record<string, unknown>) {
				if (isEmptyObject((map as Record<string, unknown>)[k])) (map as Record<string, unknown>)[k] = true;
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) {
			for (let i = 0; i < arr.length; i++) {
				if (isEmptyObject(arr[i])) arr[i] = true;
			}
		}
	}

	for (const k in obj) normalizeEmptySchemas(obj[k]);
}

/** Convert a Zod schema into the JSON Schema shape providers consume. */
export function zodToWireSchema(schema: ZodType): Record<string, unknown> {
	return stamp(schema, kZodWireSchema, s => {
		// `target: "draft-2020-12"` matches what Anthropic's `input_schema` validator
		// requires out of the box; our other provider sanitizers (OpenAI strict,
		// Google, Anthropic CCA) already handle the superset structurally.
		const raw = z.toJSONSchema(s, { target: "draft-2020-12" }) as Record<string, unknown>;
		return postProcess(raw);
	});
}

/**
 * Recursively set `additionalProperties: false` on declared object nodes lacking
 * `additionalProperties` or `patternProperties`.
 */
function closeDeclaredObjects(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) closeDeclaredObjects(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	const isObjectType = obj.type === "object" || (Array.isArray(obj.type) && obj.type.includes("object"));
	if (
		isObjectType &&
		obj.properties !== undefined &&
		!("additionalProperties" in obj) &&
		!("patternProperties" in obj)
	) {
		obj.additionalProperties = false;
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) closeDeclaredObjects(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (isRecord(map)) {
			for (const k in map as Record<string, unknown>) closeDeclaredObjects((map as Record<string, unknown>)[k]);
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) for (const child of arr) closeDeclaredObjects(child);
	}
}

/** A subschema admitting any JSON value: `{}` or boolean `true` (draft 2020-12 §4.3.1). */
function isUnconstrainedSchema(val: unknown): boolean {
	return val === true || isEmptyObject(val);
}

/**
 * Prune unconstrained empty branches ArkType emits for `T | undefined` value-unions
 * to prevent strict provider rejection while preserving runtime validation parity.
 */
function pruneArkUndefinedUnionBranches(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) pruneArkUndefinedUnionBranches(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const unionKey of ["anyOf", "oneOf"] as const) {
		const branches = obj[unionKey];
		if (!Array.isArray(branches)) continue;
		const concrete = branches.filter(branch => !isUnconstrainedSchema(branch));
		if (concrete.length === branches.length || concrete.length === 0) continue;
		const only = concrete.length === 1 ? concrete[0] : undefined;
		if (only !== undefined && isRecord(only)) {
			delete obj[unionKey];
			for (const key in only) {
				if (!(key in obj)) obj[key] = only[key];
			}
		} else {
			obj[unionKey] = concrete;
		}
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) pruneArkUndefinedUnionBranches(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (isRecord(map)) {
			for (const key in map as Record<string, unknown>) {
				pruneArkUndefinedUnionBranches((map as Record<string, unknown>)[key]);
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) for (const child of arr) pruneArkUndefinedUnionBranches(child);
	}
}

/**
 * Convert an ArkType schema into wire JSON Schema (draft 2020-12) with object closing
 * and fallback degradation for un-emittable nodes.
 */
export function arkToWireSchema(schema: Type): Record<string, unknown> {
	return stamp(schema, kArkWireSchema, s => {
		const raw = s.toJsonSchema({ target: "draft-2020-12", fallback: ctx => ctx.base }) as Record<string, unknown>;
		delete raw.$schema;
		pruneArkUndefinedUnionBranches(raw);
		const upgraded = postProcessJsonSchema(upgradeJsonSchemaTo202012(raw) as Record<string, unknown>);
		closeDeclaredObjects(upgraded);
		return upgraded;
	});
}

/**
 * Resolve tool parameters to cached wire JSON Schema (draft 2020-12), normalizing
 * Zod, ArkType, and raw schema shapes.
 */
export function toolWireSchema(tool: Tool): Record<string, unknown> {
	const params: TSchema = tool.parameters;
	if (isArkSchema(params)) return arkToWireSchema(params);
	if (isZodSchema(params)) return zodToWireSchema(params);
	return stamp(params as Record<string, unknown>, kJsonWireSchema, p => {
		const raw = isArkJsonAst(p) ? arkJsonAstToWire(p) : p;
		const upgraded = upgradeJsonSchemaTo202012(raw) as Record<string, unknown>;
		return postProcessJsonSchema(upgraded);
	});
}

/**
 * Schema-valued keywords whose value is a single subschema (or an array of
 * subschemas — the recursion dispatches on array-ness, so tuple forms like
 * draft-07 `items: []` are handled too). Covers the draft 2020-12 surface plus
 * the legacy `additionalItems` that may survive an incomplete upgrade.
 */
const STRIP_SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"additionalItems",
	"contains",
	"propertyNames",
	"contentSchema",
	"if",
	"then",
	"else",
	"not",
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
] as const;

/** Keywords whose value is a `{ name: Schema }` map — names are NOT annotations. */
const STRIP_SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;

/**
 * Recursively strip human-readable `description` annotations from a JSON Schema in place.
 */
function stripSchemaDescriptionsInPlace(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) stripSchemaDescriptionsInPlace(child);
		return;
	}
	if (!isRecord(node)) return;
	delete node.description;
	for (const key of STRIP_SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(node, key)) stripSchemaDescriptionsInPlace(node[key]);
	}
	for (const mapKey of STRIP_SCHEMA_MAP_KEYS) {
		const map = node[mapKey];
		if (isRecord(map)) {
			for (const key in map) stripSchemaDescriptionsInPlace(map[key]);
		}
	}
}

/**
 * Return a deep clone of `schema` with description annotations stripped and memoized.
 */
export function stripSchemaDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
	return stamp(schema, kStrippedSchema, source => {
		const clone = structuredClone(source);
		stripSchemaDescriptionsInPlace(clone);
		return clone;
	});
}

/**
 * Strip human-readable text from tool spec when descriptions are placed in system prompt.
 */
export function stripToolDescriptions(tools: readonly Tool[]): Tool[] {
	return tools.map(tool => ({
		...tool,
		description: "",
		parameters: stripSchemaDescriptions(toolWireSchema(tool)),
	}));
}
