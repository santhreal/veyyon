import { isRecord } from "@veyyon/utils/type-guards";

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

export function findStrictToolSchemaViolation(schema: unknown, path = "#"): string | null {
	if (Array.isArray(schema)) {
		for (let i = 0; i < schema.length; i++) {
			const hit = findStrictToolSchemaViolation(schema[i], `${path}/${i}`);
			if (hit) return hit;
		}
		return null;
	}
	if (typeof schema !== "object" || schema === null) return null;
	const node = schema as JsonRecord;

	const types = declaredTypes(node);
	if (types.length > 0) {
		if (Array.isArray(node.enum) && node.enum.some(v => !types.some(t => jsonValueMatchesType(v, t)))) {
			return `${path}/enum`;
		}
		if ("const" in node && !types.some(t => jsonValueMatchesType(node.const, t))) {
			return `${path}/const`;
		}
	}

	for (const key of CHILD_MAP_KEYS) {
		const sub = node[key];
		if (isRecord(sub)) {
			for (const k of Object.keys(sub as JsonRecord)) {
				const hit = findStrictToolSchemaViolation((sub as JsonRecord)[k], `${path}/${key}/${k}`);
				if (hit) return hit;
			}
		}
	}
	for (const key of CHILD_SCHEMA_KEYS) {
		if (key in node) {
			const hit = findStrictToolSchemaViolation(node[key], `${path}/${key}`);
			if (hit) return hit;
		}
	}
	for (const key of CHILD_ARRAY_KEYS) {
		const arr = node[key];
		if (Array.isArray(arr)) {
			const hit = findStrictToolSchemaViolation(arr, `${path}/${key}`);
			if (hit) return hit;
		}
	}
	return null;
}
