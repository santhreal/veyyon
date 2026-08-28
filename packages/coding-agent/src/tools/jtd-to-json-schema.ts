import { errorMessage, isRecord } from "@veyyon/utils";

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

function withDescription(base: unknown, raw: Record<string, unknown>): unknown {
	if (!isRecord(base)) return base;
	const meta = raw.metadata;
	if (!isRecord(meta)) return base;
	const description = meta.description;
	if (typeof description !== "string") return base;
	if ("description" in base) return base;
	return { ...base, description };
}

function applyNullable(base: unknown, nullable: boolean): unknown {
	if (!nullable) return base;
	if (!isRecord(base)) {
		return { anyOf: [base, { type: "null" }] };
	}
	const obj = base;
	if (Array.isArray(obj.enum)) {
		return obj.enum.includes(null) ? obj : { ...obj, enum: obj.enum.concat([null]) };
	}
	if ("type" in obj && !("anyOf" in obj) && !("oneOf" in obj) && !("allOf" in obj)) {
		const t = obj.type;
		if (typeof t === "string") {
			return t === "null" ? obj : { ...obj, type: [t, "null"] };
		}
		if (Array.isArray(t)) {
			return t.includes("null") ? obj : { ...obj, type: t.concat(["null"]) };
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

function convertSchemaForm(schema: object): unknown {
	if (isJTDEnum(schema)) {
		return { enum: schema.enum };
	}

	if (isJTDElements(schema)) {
		return {
			type: "array",
			items: convertSchema(schema.elements),
		};
	}

	if (isJTDType(schema)) {
		const jsonType = primitiveMap[schema.type as JTDPrimitive];
		if (!jsonType) {
			return { type: schema.type };
		}
		return { type: jsonType };
	}
	if (isJTDValues(schema)) {
		return {
			type: "object",
			additionalProperties: convertSchema(schema.values),
		};
	}

	if (isJTDProperties(schema)) {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		if (schema.properties) {
			for (const [key, value] of Object.entries(schema.properties)) {
				properties[key] = convertSchema(value);
				required.push(key);
			}
		}

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

	if (isJTDDiscriminator(schema)) {
		const oneOf: unknown[] = [];

		for (const [tag, props] of Object.entries(schema.mapping)) {
			const converted = convertSchema(props) as Record<string, unknown>;
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

	if (isJTDRef(schema)) {
		return { $ref: `#/$defs/${schema.ref}` };
	}

	return {};
}

export function isJTDSchema(schema: unknown): boolean {
	if (schema === null || typeof schema !== "object") {
		return false;
	}

	const obj = schema as Record<string, unknown>;

	if (Object.hasOwn(obj, "elements")) return true;
	if (Object.hasOwn(obj, "values")) return true;
	if (Object.hasOwn(obj, "optionalProperties")) return true;
	if (Object.hasOwn(obj, "discriminator")) return true;
	if (Object.hasOwn(obj, "ref")) return true;

	if (Object.hasOwn(obj, "type")) {
		const jtdPrimitives = ["timestamp", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32"];
		if (jtdPrimitives.includes(obj.type as string)) {
			return true;
		}
	}

	if (Object.hasOwn(obj, "properties") && !Object.hasOwn(obj, "type")) {
		return true;
	}

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
		return convertSchema(schema);
	}

	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		normalized[key] = normalizeMixedSchemaNode(value);
	}

	return normalized;
}
export function jtdToJsonSchema(schema: unknown): unknown {
	return normalizeMixedSchemaNode(schema);
}

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
