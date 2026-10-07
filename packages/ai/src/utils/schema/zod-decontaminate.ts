/**
 * Defensive rewrite for nodes that look like `JSON.stringify(zodSchemaInstance)`
 * output rather than JSON Schema. MCP servers using Zod 4 sometimes ship a
 * serialised schema instance directly as a tool's `inputSchema`, because the
 * fields Zod surfaces on its instances (`type`, `enum`, `options`, `def`) shadow
 * (and clash with) JSON Schema keywords. The resulting payload is neither valid
 * Zod nor valid JSON Schema 2020-12 and Anthropic's strict validator rejects
 * the whole tool list.
 *
 * Symptoms we've observed (gitnexus_impact.direction):
 *   {
 *     def:   { type: "enum", entries: { upstream: "upstream", ... } },
 *     type:  "enum",                       // <- invalid `type` value
 *     enum:  { upstream: "upstream", ... }, // <- `enum` MUST be an array
 *     options: ["upstream", "downstream"],
 *   }
 *
 * This module recognises the shape (`def.type === node.type` and `def.type` is
 * a known Zod kind) and rewrites it to clean JSON Schema where deterministic.
 * For Zod kinds we don't fully model, we strip the toxic siblings (`def`,
 * `options`, object-shaped `enum`) and drop an invalid `type` so the remainder
 * passes meta-schema validation as a permissive node.
 *
 * Pure / identity-preserving: returns the input reference when nothing changes.
 */

import { isRecord } from "@veyyon/utils/type-guards";
import type { JsonObject } from "./types";

const VALID_JSON_SCHEMA_TYPES: Record<string, true> = {
	string: true,
	number: true,
	integer: true,
	boolean: true,
	object: true,
	array: true,
	null: true,
};

/**
 * Known Zod 4 schema kinds as surfaced on `_def.type` / `.type`. Matching this
 * set (rather than just "has `def`") is what keeps us from rewriting legitimate
 * JSON Schemas that happen to use `def` as a property name.
 */
const ZOD_KINDS: Record<string, true> = {
	string: true,
	number: true,
	int: true,
	boolean: true,
	bigint: true,
	null: true,
	undefined: true,
	void: true,
	any: true,
	unknown: true,
	never: true,
	date: true,
	symbol: true,
	nan: true,
	enum: true,
	literal: true,
	object: true,
	array: true,
	tuple: true,
	record: true,
	map: true,
	set: true,
	union: true,
	discriminatedUnion: true,
	intersection: true,
	lazy: true,
	promise: true,
	function: true,
	file: true,
	custom: true,
	template_literal: true,
	optional: true,
	nullable: true,
	default: true,
	prefault: true,
	catch: true,
	pipe: true,
	transform: true,
	brand: true,
	readonly: true,
	success: true,
	nonoptional: true,
};

/** Every Zod 4 kind by which {@link decontaminateZodInstance} recognizes a serialized instance. */
export const ZOD_INSTANCE_KINDS: readonly string[] = Object.keys(ZOD_KINDS);

const ZOD_SCALAR_TO_JSON_TYPE: Record<string, string> = {
	string: "string",
	number: "number",
	int: "integer",
	boolean: "boolean",
	null: "null",
	bigint: "string",
	date: "string",
	nan: "number",
};

const ZOD_NOISE_KEYS: Record<string, true> = {
	def: true,
	options: true,
	_zod: true,
	checks: true,
};

/**
 * JSON Schema keywords where `null` is a legal value (literal payload positions).
 * Anywhere else, a `null`-valued key is a meta-schema violation — Zod scalars
 * leak `format: null`, `minLength: null`, etc. that we have to scrub.
 */
const KEYS_THAT_ACCEPT_NULL: Record<string, true> = {
	default: true,
	const: true,
	examples: true,
};

function isZodLeak(node: JsonObject): boolean {
	const def = node.def;
	if (!isRecord(def)) return false;
	const defType = def.type;
	if (typeof defType !== "string" || !Object.hasOwn(ZOD_KINDS, defType)) return false;
	// Both surface and inner `.type` must agree — Zod always mirrors `_def.type`
	// onto the instance, so this is a near-zero false-positive guard.
	return node.type === defType;
}

function inferTypeFromValues(values: readonly unknown[]): string {
	if (values.length === 0) return "string";
	const first = values[0];
	if (typeof first === "number") return Number.isInteger(first) ? "integer" : "number";
	if (typeof first === "boolean") return "boolean";
	if (first === null) return "null";
	return "string";
}

function unwrapInnerSchema(def: JsonObject): unknown {
	// Zod uses different fields depending on the wrapper:
	//   optional/nullable/readonly/brand/default → `innerType`
	//   pipe → `in` (or `out`)
	//   lazy → `getter` (a function — gone after JSON.stringify); fall back to {}
	return def.innerType ?? def.in ?? def.out ?? def.schema ?? def.element ?? {};
}

function copyWithoutNoise(node: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const key in node) {
		if (Object.hasOwn(ZOD_NOISE_KEYS, key)) continue;
		const value = node[key];
		if (value === null && !Object.hasOwn(KEYS_THAT_ACCEPT_NULL, key)) continue;
		out[key] = value;
	}
	return out;
}

type KindRewrite = (node: JsonObject, def: JsonObject, seen: WeakSet<object>) => unknown;

function rewriteUnion(node: JsonObject, def: JsonObject, seen: WeakSet<object>): unknown {
	const arms = Array.isArray(def.options) ? def.options : Array.isArray(node.options) ? node.options : [];
	return { anyOf: arms.map(arm => walk(arm, seen)) };
}

function rewriteKeyedCollection(_node: JsonObject, def: JsonObject, seen: WeakSet<object>): unknown {
	return { type: "object", additionalProperties: walk(def.valueType, seen) };
}

/** A wrapper kind is its inner schema. */
function rewriteWrapper(_node: JsonObject, def: JsonObject, seen: WeakSet<object>): unknown {
	return walk(unwrapInnerSchema(def), seen);
}

function rewriteNullable(_node: JsonObject, def: JsonObject, seen: WeakSet<object>): unknown {
	const inner = walk(unwrapInnerSchema(def), seen);
	if (!isRecord(inner)) return inner;
	if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
	if (Array.isArray(inner.type)) {
		return inner.type.includes("null") ? inner : { ...inner, type: [...inner.type, "null"] };
	}
	// anyOf / allOf / $ref shapes — no scalar `type` field
	return { anyOf: [inner, { type: "null" }] };
}

/** The JSON Schema rewrite of each Zod kind modelled; any other kind goes through {@link rewriteUnmodelled}. */
const KIND_REWRITES: Partial<Record<string, KindRewrite>> = {
	enum(node, def) {
		// Prefer node.options (array form Zod exposes) → def.entries values →
		// object-shaped node.enum values. All three carry the same data.
		const values = Array.isArray(node.options)
			? node.options
			: isRecord(def.entries)
				? Object.values(def.entries)
				: isRecord(node.enum)
					? Object.values(node.enum)
					: [];
		return { type: inferTypeFromValues(values), enum: values };
	},
	literal(_node, def) {
		const values = Array.isArray(def.values) ? def.values : [];
		if (values.length === 1) return { const: values[0] };
		return values.length > 1 ? { type: inferTypeFromValues(values), enum: values } : {};
	},
	union: rewriteUnion,
	discriminatedUnion: rewriteUnion,
	intersection(_node, def, seen) {
		return { allOf: [walk(def.left, seen), walk(def.right, seen)] };
	},
	array(_node, def, seen) {
		return { type: "array", items: walk(def.element, seen) };
	},
	set(_node, def, seen) {
		return { type: "array", uniqueItems: true, items: walk(def.valueType ?? def.element, seen) };
	},
	tuple(_node, def, seen) {
		const items = Array.isArray(def.items) ? def.items : [];
		const out: JsonObject = { type: "array", prefixItems: items.map(item => walk(item, seen)) };
		if (def.rest != null) out.items = walk(def.rest, seen);
		return out;
	},
	record: rewriteKeyedCollection,
	map: rewriteKeyedCollection,
	object(_node, def, seen) {
		const shape = isRecord(def.shape) ? def.shape : {};
		const properties: JsonObject = {};
		const required: string[] = [];
		for (const key in shape) {
			properties[key] = walk(shape[key], seen);
			if (!isOptionalEntry(shape[key])) required.push(key);
		}
		const out: JsonObject = { type: "object", properties };
		if (required.length > 0) out.required = required;
		return out;
	},
	nullable: rewriteNullable,
	nonoptional: rewriteWrapper,
	optional: rewriteWrapper,
	default: rewriteWrapper,
	prefault: rewriteWrapper,
	catch: rewriteWrapper,
	readonly: rewriteWrapper,
	brand: rewriteWrapper,
	lazy: rewriteWrapper,
	pipe: rewriteWrapper,
	transform: rewriteWrapper,
};

/**
 * Best-effort rewrite of a kind {@link KIND_REWRITES} does not model: drops the noise, maps the kind
 * to a JSON Schema type where one is known, and otherwise drops an invalid `type` so the node
 * validates as permissive.
 */
function rewriteUnmodelled(node: JsonObject, kind: string): JsonObject {
	const cleaned = copyWithoutNoise(node);
	const mapped = ZOD_SCALAR_TO_JSON_TYPE[kind];
	if (mapped) {
		cleaned.type = mapped;
	} else if (typeof cleaned.type === "string" && !Object.hasOwn(VALID_JSON_SCHEMA_TYPES, cleaned.type)) {
		delete cleaned.type;
	}
	// Object-shaped `enum` survives as a noise field — remove if present.
	if (cleaned.enum !== undefined && !Array.isArray(cleaned.enum)) {
		delete cleaned.enum;
	}
	return cleaned;
}

function rewriteZodNode(node: JsonObject, seen: WeakSet<object>): unknown {
	const def = node.def as JsonObject;
	const kind = def.type as string;
	// `kind` is a key of `ZOD_KINDS`, none of which names an `Object.prototype` member.
	const rewrite = KIND_REWRITES[kind];
	return rewrite ? rewrite(node, def, seen) : rewriteUnmodelled(node, kind);
}

function isOptionalEntry(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isZodLeak(value)) return false;
	const kind = (value.def as JsonObject).type;
	return kind === "optional" || kind === "default" || kind === "prefault";
}

/**
 * Walks a JSON value and rewrites every Zod-instance-shaped node into clean
 * JSON Schema 2020-12. Identity-preserving when no rewrite fires. Tolerates
 * self-referential graphs — a revisited node returns as-is.
 */
export function decontaminateZodInstance(value: unknown): unknown {
	return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
	if (Array.isArray(value)) return walkArray(value, seen);
	if (!isRecord(value)) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (isZodLeak(value)) {
		// Rewrite the node itself, then recurse into the rewrite so any nested
		// Zod-instance children get cleaned in the same pass.
		const rewritten = rewriteZodNode(value, seen);
		return rewritten === value ? value : walk(rewritten, seen);
	}
	return walkProperties(value, seen);
}

/**
 * Walks a plain JSON Schema node's values and copies the node only at its first changed value, so a
 * node with nothing to rewrite under it returns itself without allocating.
 */
function walkProperties(value: JsonObject, seen: WeakSet<object>): JsonObject {
	let out: JsonObject | undefined;
	for (const key in value) {
		const child = value[key];
		const rewritten = walk(child, seen);
		if (out) {
			out[key] = rewritten;
		} else if (rewritten !== child) {
			out = {};
			for (const earlier in value) {
				if (earlier === key) break;
				out[earlier] = value[earlier];
			}
			out[key] = rewritten;
		}
	}
	return out ?? value;
}

function walkArray(value: unknown[], seen: WeakSet<object>): unknown[] {
	if (seen.has(value)) return value;
	seen.add(value);
	let out: unknown[] | undefined;
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		const rewritten = walk(entry, seen);
		if (out) {
			out.push(rewritten);
		} else if (rewritten !== entry) {
			out = value.slice(0, i);
			out.push(rewritten);
		}
	}
	return out ?? value;
}
