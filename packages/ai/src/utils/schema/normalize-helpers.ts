import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../../error";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual } from "./equality";
import { COMBINATOR_KEYS, NON_STRUCTURAL_SCHEMA_KEYS } from "./fields";
import { isMcpUnsupportedSchemaField, isMoonshotUnsupportedSchemaField, normalizeSchema } from "./normalize";
import { enter, epochNext, exit, once, stamp } from "./stamps";
import { isJsonObjectEmpty, type JsonObject } from "./types";

export function normalizeSchemaForMCP(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isMcpUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: false,
		foldOneOfIntoAnyOf: false,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: false,
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: false,
		dropNonScalarEnum: false,
	});
}

export function normalizeSchemaForMoonshot(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isMoonshotUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: true,
		foldOneOfIntoAnyOf: true,
	});
}

export const OLLAMA_SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
export const OLLAMA_SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"dependencies",
	"dependentSchemas",
	"$defs",
	"definitions",
]);
export const OLLAMA_SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"contains",
	"contentSchema",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

export const OLLAMA_OPEN_SUBSCHEMA_WIDENING = Object.freeze({
	anyOf: [
		{ type: "string" },
		{ type: "number" },
		{ type: "boolean" },
		{ type: "object" },
		{ type: "array" },
		{ type: "null" },
	],
});

export function sanitizeSchemaForOllama(schema: JsonObject): JsonObject {
	const normalizeNode = (value: unknown): unknown => {
		if (value === true) return OLLAMA_OPEN_SUBSCHEMA_WIDENING;
		if (value === false) return { not: OLLAMA_OPEN_SUBSCHEMA_WIDENING };
		if (!isRecord(value)) {
			if (!Array.isArray(value)) return value;
			let changed = false;
			const output = value.map(item => {
				const next = normalizeNode(item);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? output : value;
		}

		let changed = false;
		const output: JsonObject = {};
		let typeAlternatives: JsonObject[] | undefined;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const child = value[key];
			if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child === "boolean") {
				changed = true;
				continue;
			}
			if (key === "type" && Array.isArray(child)) {
				const variants = child.filter((entry): entry is string => typeof entry === "string");
				const uniqueVariants = Array.from(new Set(variants));
				const nonNull = uniqueVariants.filter(entry => entry !== "null");
				if (nonNull.length <= 1) {
					output.type = nonNull[0] ?? uniqueVariants[0] ?? child[0];
				} else {
					typeAlternatives = uniqueVariants.map(entry => ({ type: entry }));
				}
				changed = true;
				continue;
			}

			let next = child;
			if (OLLAMA_SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
				let mapChanged = false;
				const mapOutput: JsonObject = {};
				for (const childKey in child) {
					if (!Object.hasOwn(child, childKey)) continue;
					const mapChild = child[childKey];
					const normalizedChild = normalizeNode(mapChild);
					if (normalizedChild !== mapChild) mapChanged = true;
					mapOutput[childKey] = normalizedChild;
				}
				next = mapChanged ? mapOutput : child;
			} else if (OLLAMA_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
				let arrayChanged = false;
				const arrayOutput = child.map(item => {
					const normalizedItem = normalizeNode(item);
					if (normalizedItem !== item) arrayChanged = true;
					return normalizedItem;
				});
				next = arrayChanged ? arrayOutput : child;
			} else if (OLLAMA_SCHEMA_VALUE_KEYS.has(key)) {
				next = normalizeNode(child);
			}
			if (next !== child) changed = true;
			output[key] = next;
		}

		if (typeAlternatives) {
			const existingAllOf = output.allOf;
			const typeUnion = { anyOf: typeAlternatives };
			output.allOf = Array.isArray(existingAllOf) ? [typeUnion, ...existingAllOf] : [typeUnion];
		}

		return changed ? output : value;
	};
	return normalizeNode(schema) as JsonObject;
}

export const OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
export const OPENAI_RESPONSES_SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"dependencies",
	"dependentSchemas",
	"$defs",
	"definitions",
]);
export const OPENAI_RESPONSES_SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"contains",
	"contentSchema",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

export function sanitizeSchemaForOpenAIResponses(schema: JsonObject): JsonObject {
	return normalizeOpenAIResponsesSchemaNode(schema, new WeakMap()) as JsonObject;
}

export const normalizeSchemaForOpenAIResponses: (schema: JsonObject) => JsonObject = sanitizeSchemaForOpenAIResponses;
export const OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS = new Set(["=", "!", "<=", "<!"]);
export const OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK = ".*";

function hasOpenAIUnsupportedRegexLookaround(pattern: string): boolean {
	let groupStart = pattern.indexOf("(?");
	while (groupStart !== -1) {
		let escapes = 0;
		for (let i = groupStart - 1; i >= 0 && pattern[i] === "\\"; i--) escapes++;
		if (escapes % 2 === 0) {
			const operator =
				pattern[groupStart + 2] === "<" ? pattern.slice(groupStart + 2, groupStart + 4) : pattern[groupStart + 2];
			if (OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has(operator)) return true;
		}
		groupStart = pattern.indexOf("(?", groupStart + 2);
	}
	return false;
}

function normalizeOpenAIResponsesSchemaNode(value: unknown, cache: WeakMap<JsonObject, unknown>): unknown {
	if (!isRecord(value)) return value;

	if (isJsonObjectEmpty(value)) return true;

	const cached = cache.get(value);
	if (cached) return cached;

	const output: JsonObject = {};
	cache.set(value, output);

	let changed = false;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (key === "oneOf" && Array.isArray(value.oneOf)) {
			changed = true;
			continue;
		}
		if (
			key === "pattern" &&
			typeof value.pattern === "string" &&
			hasOpenAIUnsupportedRegexLookaround(value.pattern)
		) {
			changed = true;
			continue;
		}

		const child = value[key];
		let next: unknown = child;
		if (key === "patternProperties" && isRecord(child)) {
			next = normalizeOpenAIResponsesSchemaMap(child, cache, true);
		} else if (OPENAI_RESPONSES_SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
			next = normalizeOpenAIResponsesSchemaMap(child, cache, false);
		} else if (OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
			next = normalizeOpenAIResponsesSchemaArray(child, cache);
		} else if (OPENAI_RESPONSES_SCHEMA_VALUE_KEYS.has(key) && isRecord(child)) {
			next = normalizeOpenAIResponsesSchemaNode(child, cache);
		}

		if (next !== child) changed = true;
		output[key] = next;
	}

	if (Array.isArray(value.oneOf)) {
		const rewrittenOneOf = normalizeOpenAIResponsesSchemaArray(value.oneOf, cache);
		const existingAnyOf = output.anyOf;
		output.anyOf = Array.isArray(existingAnyOf)
			? (existingAnyOf as unknown[]).concat(rewrittenOneOf as unknown[])
			: rewrittenOneOf;
	}

	if (declaresObjectType(value.type) && !Object.hasOwn(value, "properties")) {
		output.properties = {};
		changed = true;
	}

	const result = changed ? (isJsonObjectEmpty(output) ? true : output) : value;
	cache.set(value, result);
	return result;
}

function declaresObjectType(type: unknown): boolean {
	if (type === "object") return true;
	if (!Array.isArray(type)) return false;
	for (const variant of type) {
		if (variant === "object") return true;
	}
	return false;
}

function normalizeOpenAIResponsesSchemaArray(value: unknown[], cache: WeakMap<JsonObject, unknown>): unknown[] {
	let changed = false;
	const output = value.map(item => {
		const next = normalizeOpenAIResponsesSchemaNode(item, cache);
		if (next !== item) changed = true;
		return next;
	});
	return changed ? output : value;
}

function normalizeOpenAIResponsesSchemaMap(
	schemaMap: JsonObject,
	cache: WeakMap<JsonObject, unknown>,
	stripUnsupportedRegexKeys: boolean,
): JsonObject {
	let changed = false;
	const output: JsonObject = {};
	for (const key in schemaMap) {
		if (!Object.hasOwn(schemaMap, key)) continue;
		const child = schemaMap[key];
		const next = normalizeOpenAIResponsesSchemaNode(child, cache);
		if (next !== child) changed = true;
		if (stripUnsupportedRegexKeys && hasOpenAIUnsupportedRegexLookaround(key)) {
			changed = true;
			appendOpenAIResponsesFallbackPatternProperty(output, next);
			continue;
		}
		output[key] = next;
	}
	return changed ? output : schemaMap;
}

function appendOpenAIResponsesFallbackPatternProperty(output: JsonObject, schema: unknown): void {
	const existing = output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK];
	if (existing === undefined) {
		output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = schema;
		return;
	}
	if (isRecord(existing) && Array.isArray(existing.anyOf) && Object.keys(existing).length === 1) {
		existing.anyOf = existing.anyOf.concat([schema]);
		return;
	}
	output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = { anyOf: [existing, schema] };
}

export type StrictPrimitiveType = "null" | "string" | "number" | "boolean";

function primitiveJsonTypeOf(value: unknown): StrictPrimitiveType | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		default:
			return undefined;
	}
}
function jsonSchemaTypeAcceptsValue(type: string, value: unknown): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value);
		default:
			return true;
	}
}

function narrowEnumToType(schema: Record<string, unknown>, type: string): boolean {
	const enumValues = schema.enum;
	if (!Array.isArray(enumValues)) return true;

	const narrowed = enumValues.filter(value => jsonSchemaTypeAcceptsValue(type, value));
	if (narrowed.length === 0) return false;
	if (narrowed.length !== enumValues.length) schema.enum = narrowed;
	return true;
}

function inferStrictPrimitiveTypeFromEnumOrConst(
	node: Record<string, unknown>,
): StrictPrimitiveType | undefined {
	const values: unknown[] = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : [];
	if (values.length === 0) return undefined;
	let inferred: StrictPrimitiveType | undefined;
	for (const value of values) {
		const t = primitiveJsonTypeOf(value);
		if (t === undefined) return undefined; // non-primitive (object/array) — strict can't represent
		if (inferred === undefined) inferred = t;
		else if (inferred !== t) return undefined; // mixed primitives
	}
	return inferred;
}

export const kStrictSchema = Symbol("pi.schema.strict");

function isUnrepresentableStrictBranch(value: unknown): boolean {
	return typeof value === "boolean" || (isRecord(value) && isJsonObjectEmpty(value));
}

function hasUnrepresentableStrictObjectMap(
	schema: Record<string, unknown>,
	epoch: number = epochNext(),
): boolean {
	if (!once(schema, epoch)) return false;

	let hasPatternProperties = false;
	if (isRecord(schema.patternProperties)) {
		for (const _ in schema.patternProperties) {
			hasPatternProperties = true;
			break;
		}
	}
	const additionalPropertiesValue = schema.additionalProperties;
	const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isRecord(additionalPropertiesValue);
	if (hasPatternProperties || hasSchemaAdditionalProperties) {
		return true;
	}

	if (isRecord(schema.properties)) {
		const properties = schema.properties;
		for (const k in properties) {
			const propertySchema = properties[k];
			if (isUnrepresentableStrictBranch(propertySchema)) return true;
			if (isRecord(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, epoch)) {
				return true;
			}
		}
	}

	if (isUnrepresentableStrictBranch(schema.items)) {
		return true;
	}
	if (isRecord(schema.items)) {
		if (hasUnrepresentableStrictObjectMap(schema.items, epoch)) {
			return true;
		}
	} else if (Array.isArray(schema.items)) {
		for (const itemSchema of schema.items) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isRecord(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}
	if (Array.isArray(schema.prefixItems)) {
		for (const itemSchema of schema.prefixItems) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isRecord(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (isUnrepresentableStrictBranch(variant)) return true;
			if (isRecord(variant) && hasUnrepresentableStrictObjectMap(variant, epoch)) {
				return true;
			}
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const defs = schema[defsKey];
		if (!isRecord(defs)) continue;
		for (const k in defs) {
			const defSchema = defs[k];
			if (isUnrepresentableStrictBranch(defSchema)) return true;
			if (isRecord(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, epoch)) {
				return true;
			}
		}
	}

	return false;
}

export function sanitizeSchemaForStrictMode(
	schema: Record<string, unknown>,
	epoch: number = epochNext(),
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
	root: Record<string, unknown> = schema,
): Record<string, unknown> {
	const cached = cache.get(schema);
	if (cached) return cached;
	if (!once(schema, epoch)) return {};

	if (typeof schema.$ref === "string") {
		let hasSibling = false;
		for (const k in schema) {
			if (k !== "$ref" && Object.hasOwn(schema, k)) {
				hasSibling = true;
				break;
			}
		}
		if (hasSibling) {
			const resolved = resolveStrictRef(root, schema.$ref);
			if (resolved !== undefined) {
				const merged: Record<string, unknown> = { ...resolved };
				for (const k in schema) {
					if (k === "$ref" || !Object.hasOwn(schema, k)) continue;
					merged[k] = schema[k];
				}
				const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
				cache.set(schema, result);
				return result;
			}
		}
	}

	{
		const allOf = schema.allOf;
		if (Array.isArray(allOf) && allOf.length === 1 && isRecord(allOf[0])) {
			const merged: Record<string, unknown> = { ...schema };
			delete merged.allOf;
			const sole = allOf[0] as Record<string, unknown>;
			for (const k in sole) {
				if (Object.hasOwn(sole, k)) merged[k] = sole[k];
			}
			const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
			cache.set(schema, result);
			return result;
		}
	}

	const typeValue = schema.type;
	if (Array.isArray(typeValue)) {
		const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
		const schemaWithoutType = { ...schema };
		delete schemaWithoutType.type;

		const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, epoch, cache, root);
		if (typeVariants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}
		const { description, ...variantBase } = sanitizedWithoutType;
		const variants: Record<string, unknown>[] = [];
		for (const variantType of typeVariants) {
			const variantSchema: Record<string, unknown> = { ...variantBase, type: variantType };
			if (variantType !== "object") {
				delete variantSchema.properties;
				delete variantSchema.required;
				delete variantSchema.additionalProperties;
			}
			if (variantType !== "array") {
				delete variantSchema.items;
			}
			if (!narrowEnumToType(variantSchema, variantType)) continue;
			variants.push(sanitizeSchemaForStrictMode(variantSchema, epoch, cache, root));
		}

		if (variants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}

		if (variants.length === 1) {
			const sole = variants[0] as Record<string, unknown>;
			if (description !== undefined && !Object.hasOwn(sole, "description")) {
				sole.description = description;
			}
			cache.set(schema, sole);
			return sole;
		}

		const result: JsonObject = { anyOf: variants };
		if (description !== undefined) result.description = description;
		cache.set(schema, result);
		return result;
	}

	const sanitized: Record<string, unknown> = {};
	cache.set(schema, sanitized);
	for (const key in schema) {
		const value = schema[key];
		if (key in NON_STRUCTURAL_SCHEMA_KEYS || key === "type" || key === "const" || key === "nullable") {
			continue;
		}

		if (key === "properties" && isRecord(value)) {
			const properties: Record<string, unknown> = {};
			for (const propertyName in value) {
				const propertySchema = value[propertyName];
				properties[propertyName] = isRecord(propertySchema)
					? sanitizeSchemaForStrictMode(propertySchema, epoch, cache, root)
					: propertySchema;
			}
			sanitized.properties = properties;
			continue;
		}

		if (key === "items") {
			if (isRecord(value)) {
				sanitized.items = sanitizeSchemaForStrictMode(value, epoch, cache, root);
			} else if (Array.isArray(value)) {
				sanitized.items = value.map(entry =>
					isRecord(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
				);
			} else {
				sanitized.items = value;
			}
			continue;
		}

		if (key === "prefixItems" && Array.isArray(value)) {
			sanitized.prefixItems = value.map(entry =>
				isRecord(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}

		if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
			sanitized[key] = value.map(entry =>
				isRecord(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}

		if ((key === "$defs" || key === "definitions") && isRecord(value)) {
			const defs: Record<string, unknown> = {};
			for (const definitionName in value) {
				const definitionSchema = value[definitionName];
				defs[definitionName] = isRecord(definitionSchema)
					? sanitizeSchemaForStrictMode(definitionSchema, epoch, cache, root)
					: definitionSchema;
			}
			sanitized[key] = defs;
			continue;
		}

		if (key === "additionalProperties") {
			continue;
		}

		if (key === "description" && typeof value === "string" && schema.default !== undefined) {
			const defaultVal = schema.default;
			const formatted = typeof defaultVal === "string" ? defaultVal : JSON.stringify(defaultVal);
			sanitized.description = value.includes("(default:") ? value : `${value} (default: ${formatted})`;
			continue;
		}

		sanitized[key] = value;
	}

	if (Object.hasOwn(schema, "const")) {
		const constVal = schema.const;
		const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
		if (!existingEnum.some(v => areJsonValuesEqual(v, constVal))) {
			existingEnum.push(constVal);
		}
		sanitized.enum = existingEnum;
	}

	if (typeof typeValue === "string") {
		sanitized.type = typeValue;
	}

	if (sanitized.type === undefined && isRecord(sanitized.properties)) {
		sanitized.type = "object";
	}

	if (sanitized.type === undefined && (sanitized.items !== undefined || sanitized.prefixItems !== undefined)) {
		sanitized.type = "array";
	}

	if (sanitized.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(sanitized);
		if (inferred !== undefined) sanitized.type = inferred;
	}

	if (schema.nullable === true) {
		const { nullable: _, description, ...withoutNullable } = sanitized;
		const wrapper: JsonObject = { anyOf: [withoutNullable, { type: "null" }] };
		if (description !== undefined) wrapper.description = description;
		return wrapper;
	}

	return sanitized;
}

function isPureAnyOfNode(value: unknown): value is Record<string, unknown> & { anyOf: unknown[] } {
	if (!isRecord(value) || !Array.isArray(value.anyOf)) return false;
	for (const key in value) {
		if (key !== "anyOf" && key !== "description") return false;
	}
	return true;
}

export function enforceStrictSchema(
	schema: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): Record<string, unknown> {
	if (!enter(schema)) {
		throw new AIError.ValidationError("Schema contains a circular object graph — cannot enforce strict mode");
	}
	try {
		const cached = cache.get(schema);
		if (cached) return cached;
		const result = { ...schema };
		cache.set(schema, result);
		return enforceStrictSchemaBody(schema, result, cache);
	} finally {
		exit(schema);
	}
}

function enforceStrictSchemaBody(
	_schema: Record<string, unknown>,
	result: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	const isObjectType = result.type === "object";
	if (isObjectType) {
		result.additionalProperties = false;
		const propertiesValue = result.properties;
		const props =
			propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
				? (propertiesValue as Record<string, unknown>)
				: {};
		const originalRequired = new Set<string>(
			Array.isArray(result.required)
				? result.required.filter((value): value is string => typeof value === "string")
				: [],
		);
		const strictProperties: Record<string, unknown> = {};
		for (const key in props) {
			const value = props[key];
			const processed =
				value != null && typeof value === "object" && !Array.isArray(value)
					? enforceStrictSchema(value as Record<string, unknown>, cache)
					: value;
			if (!originalRequired.has(key)) {
				if (
					isRecord(processed) &&
					Array.isArray(processed.anyOf) &&
					processed.anyOf.some(v => isRecord(v) && v.type === "null")
				) {
					strictProperties[key] = processed;
					continue;
				}
				if (isPureAnyOfNode(processed)) {
					strictProperties[key] = { ...processed, anyOf: processed.anyOf.concat([{ type: "null" }]) };
					continue;
				}
				if (isRecord(processed) && typeof processed.description === "string") {
					const { description, ...withoutDescription } = processed;
					strictProperties[key] = { anyOf: [withoutDescription, { type: "null" }], description };
					continue;
				}
				strictProperties[key] = { anyOf: [processed, { type: "null" }] };
				continue;
			}
			strictProperties[key] = processed;
		}
		result.properties = strictProperties;
		result.required = Object.keys(strictProperties);
	}
	if (result.items != null && typeof result.items === "object") {
		if (Array.isArray(result.items)) {
			result.items = result.items.map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		} else {
			result.items = enforceStrictSchema(result.items as Record<string, unknown>, cache);
		}
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(entry =>
			entry != null && typeof entry === "object" && !Array.isArray(entry)
				? enforceStrictSchema(entry as Record<string, unknown>, cache)
				: entry,
		);
	}
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		}
	}
	if (Array.isArray(result.anyOf) && result.anyOf.some(isPureAnyOfNode)) {
		const flattened: unknown[] = [];
		for (const branch of result.anyOf) {
			if (!isPureAnyOfNode(branch)) {
				flattened.push(branch);
				continue;
			}
			for (let ai = 0; ai < branch.anyOf.length; ai++) flattened.push(branch.anyOf[ai]!);
			if (typeof branch.description === "string" && result.description === undefined) {
				result.description = branch.description;
			}
		}
		result.anyOf = flattened;
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
			const defs = result[defsKey] as Record<string, unknown>;
			const nextDefs: Record<string, unknown> = {};
			for (const name in defs) {
				const def = defs[name];
				nextDefs[name] =
					def != null && typeof def === "object" && !Array.isArray(def)
						? enforceStrictSchema(def as Record<string, unknown>, cache)
						: def;
			}
			result[defsKey] = nextDefs;
		}
	}
	if (result.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(result);
		if (inferred !== undefined) result.type = inferred;
	}
	if (
		result.type === undefined &&
		result.$ref === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(result[key])) &&
		!isRecord(result.not)
	) {
		throw new AIError.ValidationError("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
	}
	return result;
}

export function tryEnforceStrictSchema(schema: Record<string, unknown>): {
	schema: Record<string, unknown>;
	strict: boolean;
} {
	return stamp(schema, kStrictSchema, s => {
		const upgraded = upgradeJsonSchemaTo202012(s) as Record<string, unknown>;
		if (hasUnrepresentableStrictObjectMap(upgraded)) {
			return { schema: upgraded, strict: false };
		}
		try {
			const sanitized = sanitizeSchemaForStrictMode(upgraded);
			return { schema: enforceStrictSchema(sanitized), strict: true };
		} catch {
			return { schema: upgraded, strict: false };
		}
	});
}

function resolveStrictRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
	if (!ref.startsWith("#/")) return undefined;
	const segments = ref.slice(2).split("/");
	let cursor: unknown = root;
	for (const raw of segments) {
		if (!isRecord(cursor)) return undefined;
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		cursor = cursor[segment];
	}
	return isRecord(cursor) ? cursor : undefined;
}
