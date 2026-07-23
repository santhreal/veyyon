import { errorMessage } from "@veyyon/utils";
/**
 * Convert JSON Type Definition (JTD) to JSON Schema.
 *
 * JTD (RFC 8927) is a simpler schema format. This converter allows users to
 * write schemas in JTD and have them converted to JSON Schema for model APIs.
 *
 * @see https://jsontypedef.com/
 * @see https://datatracker.ietf.org/doc/html/rfc8927
 */

import type { JTDPrimitive } from "./jtd-utils.js";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "./jtd-utils.js";

const primitiveMap: Record<JTDPrimitive, string> = {
	boolean: "boolean",
	string: "string",
	timestamp: "string", // ISO 8601
	float32: "number",
	float64: "number",
	int8: "integer",
	uint8: "integer",
	int16: "integer",
	uint16: "integer",
	int32: "integer",
	uint32: "integer",
};

/**
 * Carry a JTD `metadata.description` onto the converted JSON Schema node as a
 * top-level `description`. JTD keeps human-facing annotations under `metadata`
 * (see RFC 8927 §5); JSON Schema uses a top-level `description`. Dropping it
 * silently loses the guidance a model relies on when the schema drives its
 * output. Only a string `description` is lifted, and an existing one is never
 * overwritten. Non-object bases (an `unknown` primitive, an array) pass through.
 */
function withDescription(base: unknown, raw: Record<string, unknown>): unknown {
	if (base === null || typeof base !== "object" || Array.isArray(base)) return base;
	const meta = raw.metadata;
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return base;
	const description = (meta as Record<string, unknown>).description;
	if (typeof description !== "string") return base;
	if ("description" in (base as Record<string, unknown>)) return base;
	return { ...(base as Record<string, unknown>), description };
}

/**
 * Honor JTD's `nullable: true` on a converted node. JTD marks a value nullable
 * with a sibling `nullable` keyword (RFC 8927 §3.2); JSON Schema has no such
 * keyword, so the null-ness must be folded into the shape itself. A node with a
 * string `type` gains `"null"` in a `type` array, an array `type` gains it if
 * absent, an `enum` gains a `null` member, and anything else (a `$ref`, a
 * discriminator's `oneOf`) is wrapped in `anyOf` with `{ type: "null" }`.
 * Without this the converter narrowed every nullable JTD form to a
 * non-nullable JSON Schema, so a model's valid `null` failed validation.
 */
function applyNullable(base: unknown, nullable: boolean): unknown {
	if (!nullable) return base;
	if (base === null || typeof base !== "object" || Array.isArray(base)) {
		return { anyOf: [base, { type: "null" }] };
	}
	const obj = base as Record<string, unknown>;
	if (Array.isArray(obj.enum)) {
		return obj.enum.includes(null) ? obj : { ...obj, enum: [...obj.enum, null] };
	}
	if ("type" in obj && !("anyOf" in obj) && !("oneOf" in obj) && !("allOf" in obj)) {
		const t = obj.type;
		if (typeof t === "string") {
			return t === "null" ? obj : { ...obj, type: [t, "null"] };
		}
		if (Array.isArray(t)) {
			return t.includes("null") ? obj : { ...obj, type: [...t, "null"] };
		}
	}
	return { anyOf: [obj, { type: "null" }] };
}

function convertSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") {
		return {};
	}
	const raw = schema as Record<string, unknown>;
	const base = convertSchemaForm(schema);
	return applyNullable(withDescription(base, raw), raw.nullable === true);
}

/**
 * Convert a single JTD form to its JSON Schema shape, ignoring the cross-cutting
 * `nullable` and `metadata` keywords. {@link convertSchema} wraps this to fold
 * those in, so every form honors them in one place.
 */
function convertSchemaForm(schema: object): unknown {
	// Enum form: { enum: ["a", "b"] } → { enum: ["a", "b"] }
	if (isJTDEnum(schema)) {
		return { enum: schema.enum };
	}

	// Elements form: { elements: { type: "string" } } → { type: "array", items: ... }
	if (isJTDElements(schema)) {
		return {
			type: "array",
			items: convertSchema(schema.elements),
		};
	}

	// Type form: { type: "string" } → { type: "string" }
	if (isJTDType(schema)) {
		const jsonType = primitiveMap[schema.type as JTDPrimitive];
		if (!jsonType) {
			return { type: schema.type };
		}
		return { type: jsonType };
	}
	// Values form: { values: { type: "string" } } → { type: "object", additionalProperties: ... }
	if (isJTDValues(schema)) {
		return {
			type: "object",
			additionalProperties: convertSchema(schema.values),
		};
	}

	// Properties form: { properties: {...}, optionalProperties: {...} }
	if (isJTDProperties(schema)) {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		// Required properties
		if (schema.properties) {
			for (const [key, value] of Object.entries(schema.properties)) {
				properties[key] = convertSchema(value);
				required.push(key);
			}
		}

		// Optional properties
		if (schema.optionalProperties) {
			for (const [key, value] of Object.entries(schema.optionalProperties)) {
				properties[key] = convertSchema(value);
			}
		}

		const result: Record<string, unknown> = {
			type: "object",
			properties,
			additionalProperties: false,
		};

		if (required.length > 0) {
			result.required = required;
		}

		return result;
	}

	// Discriminator form: { discriminator: "type", mapping: { ... } }
	if (isJTDDiscriminator(schema)) {
		const oneOf: unknown[] = [];

		for (const [tag, props] of Object.entries(schema.mapping)) {
			const converted = convertSchema(props) as Record<string, unknown>;
			// Add the discriminator property
			const properties = (converted.properties || {}) as Record<string, unknown>;
			properties[schema.discriminator] = { const: tag };

			const required = ((converted.required as string[]) || []).slice();
			if (!required.includes(schema.discriminator)) {
				required.push(schema.discriminator);
			}

			oneOf.push({
				...converted,
				properties,
				required,
			});
		}

		return { oneOf };
	}

	// Ref form: { ref: "MyType" } → { $ref: "#/$defs/MyType" }
	if (isJTDRef(schema)) {
		return { $ref: `#/$defs/${schema.ref}` };
	}

	// Empty form: {} → {} (accepts anything)
	return {};
}

/**
 * Detect if a schema is JTD format (vs JSON Schema).
 *
 * JTD schemas use: type (primitives), properties, optionalProperties, elements, values, enum, discriminator, ref
 * JSON Schema uses: type: "object", type: "array", items, additionalProperties, etc.
 */
export function isJTDSchema(schema: unknown): boolean {
	if (schema === null || typeof schema !== "object") {
		return false;
	}

	const obj = schema as Record<string, unknown>;

	// Keyword detection uses OWN-property checks, never `in`: `in` walks the
	// prototype chain, so `"values" in []` is true (Array.prototype.values) and any
	// array would be mis-detected as a JTD values-form schema. A JTD keyword only
	// counts when it is an own property of the schema object.
	if (Object.hasOwn(obj, "elements")) return true;
	if (Object.hasOwn(obj, "values")) return true;
	if (Object.hasOwn(obj, "optionalProperties")) return true;
	if (Object.hasOwn(obj, "discriminator")) return true;
	if (Object.hasOwn(obj, "ref")) return true;

	// JTD type primitives (JSON Schema doesn't have int32, float64, etc.)
	if (Object.hasOwn(obj, "type")) {
		const jtdPrimitives = ["timestamp", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32"];
		if (jtdPrimitives.includes(obj.type as string)) {
			return true;
		}
	}

	// JTD properties form without type: "object" (JSON Schema requires it)
	if (Object.hasOwn(obj, "properties") && !Object.hasOwn(obj, "type")) {
		return true;
	}

	// JTD enum form: a bare `enum` with no `type`. JSON Schema's enum constraint
	// almost always rides alongside a `type` (e.g. `{ type: "string", enum: [...] }`)
	// and must stay untouched, so this only claims the type-less shape. Converting
	// it is a no-op for the enum itself (`{ enum } → { enum }`), so nothing is ever
	// dropped, but routing it through the converter folds sibling `nullable`/
	// `metadata` keywords in correctly instead of leaking them unconverted.
	if (Object.hasOwn(obj, "enum") && !Object.hasOwn(obj, "type")) {
		return true;
	}

	return false;
}

function normalizeMixedSchemaNode(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") {
		return schema;
	}

	if (Array.isArray(schema)) {
		return schema.map(item => normalizeMixedSchemaNode(item));
	}

	if (isJTDSchema(schema)) {
		// `convertSchema` is itself fully recursive and emits pure JSON Schema, so
		// re-walking the result with `normalizeMixedSchemaNode` is unnecessary and
		// unsafe: it would treat user-named properties whose keys happen to be JTD
		// keywords (e.g. `ref`, `elements`) as nested JTD forms (#1345).
		return convertSchema(schema);
	}

	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		normalized[key] = normalizeMixedSchemaNode(value);
	}

	return normalized;
}
/**
 * Convert JTD schema to JSON Schema.
 * If already JSON Schema, returns as-is.
 */
export function jtdToJsonSchema(schema: unknown): unknown {
	return normalizeMixedSchemaNode(schema);
}

/**
 * Normalize a schema input that may be a JSON string, object, or null/undefined.
 * Returns { normalized } on success, or { error } if JSON parsing fails.
 */
export function normalizeSchema(schema: unknown): { normalized?: unknown; error?: string } {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: errorMessage(err) };
		}
	}
	return { normalized: schema };
}
