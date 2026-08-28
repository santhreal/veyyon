import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { dereferenceJsonSchema } from "./dereference";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual, mergeCompatibleEnumSchemas, mergePropertySchemas } from "./equality";
import {
	ALL_CCA_TYPE_SPECIFIC_KEYS,
	CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS,
	CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS,
	LIFTABLE_TO_DESCRIPTION_FIELDS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { type DescriptionSpillFormat, spillToDescription } from "./spill";
import { enter, epochNext, exit, once } from "./stamps";
import type { JsonObject } from "./types";
import { decontaminateZodInstance } from "./zod-decontaminate";

export {
	enforceStrictSchema,
	normalizeSchemaForMCP,
	normalizeSchemaForMoonshot,
	normalizeSchemaForOpenAIResponses,
	sanitizeSchemaForOllama,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "./normalize-helpers";

export type ResidualSchemaIncompatibility = "type-array" | "type-null" | "nullable" | "combiners";

export interface NormalizeSchemaOptions {
	unsupportedFields: (key: string) => boolean;
	normalizeFieldNames: boolean;
	collapseNullFields: boolean;
	normalizeTypeArrayToNullable: boolean;
	stripNullableKeyword: boolean;
	autoPropertyOrdering: boolean;
	ensureObjectProperties: boolean;
	liftStrippedToDescription:
		| false
		| {
				keys?: (key: string) => boolean;
				format?: DescriptionSpillFormat;
		  };
	mergeObjectCombiners: boolean;
	collapseSameTypeCombiners: boolean;
	collapseMixedTypeCombiners: boolean;
	stripResidualCombinersFixpoint: boolean;
	extractNullableFromUnions: boolean;
	inferTypeForBareEnum: boolean;
	foldOneOfIntoAnyOf: boolean;
	dropNonScalarEnum: boolean;
	rejectResidualIncompatibilities?: ReadonlyArray<ResidualSchemaIncompatibility>;
	validateAndFallback?: { fallback: unknown };
}

interface NormalizeSchemaWalkOptions extends NormalizeSchemaOptions {
	insideProperties: boolean;
}

interface ResidualIncompatibilityChecks {
	typeArray: boolean;
	typeNull: boolean;
	nullable: boolean;
	combiners: boolean;
}

const SNAKE_TO_CAMEL_RENAMES = new Map<string, string>([
	["additional_properties", "additionalProperties"],
	["any_of", "anyOf"],
	["prefix_items", "prefixItems"],
	["property_ordering", "propertyOrdering"],
]);

const JSON_SCHEMA_COMBINERS = ["anyOf", "oneOf"] as const;
const CCA_FORBIDDEN_COMBINERS = new Set(["anyOf", "oneOf", "allOf"]);

const CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA = {
	type: "object",
	properties: {},
} as const;

function isGoogleUnsupportedSchemaField(key: string): boolean {
	return Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key);
}

export function isMcpUnsupportedSchemaField(key: string): boolean {
	return key === "$schema";
}

export function isMoonshotUnsupportedSchemaField(key: string): boolean {
	if (key === "default") return false;
	return Object.hasOwn(NON_STRUCTURAL_SCHEMA_KEYS, key) || key === "prefixItems";
}

function isDefaultLiftableToDescriptionField(key: string): boolean {
	return Object.hasOwn(LIFTABLE_TO_DESCRIPTION_FIELDS, key);
}

function applySnakeCaseRenames(obj: JsonObject): JsonObject {
	let needsRename = false;
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		if (SNAKE_TO_CAMEL_RENAMES.has(k)) {
			needsRename = true;
			break;
		}
	}
	if (!needsRename) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		const renamed = SNAKE_TO_CAMEL_RENAMES.get(k);
		if (renamed !== undefined) {
			out[renamed] = obj[k];
		} else if (!outHasOwn(out, k)) {
			out[k] = obj[k];
		}
	}
	return out;
}

function preHandleNullFields(obj: JsonObject): JsonObject {
	if (obj.type === "null") {
		const out: JsonObject = {};
		for (const k in obj) {
			if (!Object.hasOwn(obj, k) || k === "type") continue;
			out[k] = obj[k];
		}
		out.nullable = true;
		return out;
	}
	if (!Array.isArray(obj.anyOf)) return obj;
	const variants = obj.anyOf as unknown[];
	let sawNull = false;
	const kept: unknown[] = [];
	for (const v of variants) {
		if (isRecord(v) && v.type === "null") {
			sawNull = true;
			continue;
		}
		kept.push(v);
	}
	if (!sawNull) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (Object.hasOwn(obj, k)) out[k] = obj[k];
	}
	out.nullable = true;
	if (kept.length === 0) {
		delete out.anyOf;
	} else if (kept.length === 1 && isRecord(kept[0])) {
		delete out.anyOf;
		const only = kept[0];
		for (const k in only) {
			if (Object.hasOwn(only, k) && !outHasOwn(out, k)) out[k] = only[k];
		}
	} else {
		out.anyOf = kept;
	}
	return out;
}

function outHasOwn(obj: JsonObject, key: string): boolean {
	return Object.hasOwn(obj, key);
}

function inferJsonSchemaTypeFromValue(value: unknown): string | undefined {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		default:
			return undefined;
	}
}

function pushEnumValue(values: unknown[], value: unknown): void {
	if (!values.some(existing => areJsonValuesEqual(existing, value))) {
		values.push(value);
	}
}

function pushStrippedDescriptionEntry(
	spill: Array<[string, unknown]> | undefined,
	key: string,
	value: unknown,
	options: NormalizeSchemaWalkOptions,
): Array<[string, unknown]> | undefined {
	const lift = options.liftStrippedToDescription;
	if (!lift) return spill;
	const isLiftable = lift.keys ?? isDefaultLiftableToDescriptionField;
	if (!isLiftable(key)) return spill;
	const next = spill ?? [];
	next.push([key, value]);
	return next;
}

function applyDescriptionSpill(
	result: JsonObject,
	spill: Array<[string, unknown]> | undefined,
	options: NormalizeSchemaWalkOptions,
): void {
	const lift = options.liftStrippedToDescription;
	if (!lift || spill === undefined) return;
	spillToDescription(result, spill, lift.format ?? "spill");
}

function normalizeSchemaNode(value: unknown, options: NormalizeSchemaWalkOptions): unknown {
	if (Array.isArray(value)) {
		if (!enter(value)) return [];
		try {
			return value.map(entry => normalizeSchemaNode(entry, options));
		} finally {
			exit(value);
		}
	}
	if (!isRecord(value)) {
		return value;
	}
	if (!enter(value)) return {};
	try {
		return normalizeSchemaObjectNode(value, options);
	} finally {
		exit(value);
	}
}

function normalizeSchemaObjectNode(value: JsonObject, options: NormalizeSchemaWalkOptions): unknown {
	let obj = options.normalizeFieldNames && !options.insideProperties ? applySnakeCaseRenames(value) : value;
	if (options.collapseNullFields && !options.insideProperties) {
		obj = preHandleNullFields(obj);
	}
	const result: JsonObject = {};
	let spill: Array<[string, unknown]> | undefined;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (!Array.isArray(obj[combiner])) continue;
		const variants = obj[combiner] as JsonObject[];
		const allHaveConst = variants.every(v => isRecord(v) && "const" in v);
		if (!allHaveConst || variants.length === 0) continue;

		const dedupedEnum: unknown[] = [];
		for (const variant of variants) {
			pushEnumValue(dedupedEnum, variant.const);
		}
		result.enum = dedupedEnum;

		const explicitTypes = variants
			.map(variant => variant.type)
			.filter((variantType): variantType is string => typeof variantType === "string");
		const allHaveSameExplicitType =
			explicitTypes.length === variants.length &&
			explicitTypes.every(variantType => variantType === explicitTypes[0]);
		if (allHaveSameExplicitType && explicitTypes[0]) {
			result.type = explicitTypes[0];
		} else {
			const inferredTypes = dedupedEnum
				.map(enumValue => inferJsonSchemaTypeFromValue(enumValue))
				.filter((inferredType): inferredType is string => inferredType !== undefined);
			const inferredTypeSet = new Set(inferredTypes);
			if (inferredTypeSet.size === 1) {
				result.type = inferredTypes[0];
			} else {
				const nonNullInferredTypes = inferredTypes.filter(inferredType => inferredType !== "null");
				const nonNullTypeSet = new Set(nonNullInferredTypes);
				if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
					result.type = nonNullInferredTypes[0];
					if (!options.stripNullableKeyword) {
						result.nullable = true;
					}
				}
			}
		}

		for (const key in obj) {
			if (!Object.hasOwn(obj, key) || key === combiner || outHasOwn(result, key)) continue;
			const entry = obj[key];
			if (!options.insideProperties && options.unsupportedFields(key)) {
				spill = pushStrippedDescriptionEntry(spill, key, entry, options);
				continue;
			}
			if (options.stripNullableKeyword && key === "nullable") continue;
			result[key] = normalizeSchemaNode(entry, {
				...options,
				insideProperties: !options.insideProperties && key === "properties",
			});
		}
		applyDescriptionSpill(result, spill, options);
		return applyNodePostProcessing(result, options);
	}

	let constValue: unknown;
	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const entry = obj[key];
		if (!options.insideProperties && options.unsupportedFields(key)) {
			spill = pushStrippedDescriptionEntry(spill, key, entry, options);
			continue;
		}
		if (options.stripNullableKeyword && key === "nullable") continue;
		if (key === "const") {
			constValue = entry;
			continue;
		}
		result[key] = normalizeSchemaNode(entry, {
			...options,
			insideProperties: !options.insideProperties && key === "properties",
		});
	}

	if (options.normalizeTypeArrayToNullable && Array.isArray(result.type)) {
		const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null") && !options.stripNullableKeyword) {
			result.nullable = true;
		}
		result.type = nonNull[0] ?? types[0];
	}
	if (constValue !== undefined) {
		const existingEnum = Array.isArray(result.enum) ? result.enum : [];
		pushEnumValue(existingEnum, constValue);
		result.enum = existingEnum;
		if (!result.type) {
			result.type = inferJsonSchemaTypeFromValue(constValue);
		}
	}

	if (
		options.inferTypeForBareEnum &&
		!result.type &&
		!Array.isArray(result.anyOf) &&
		!Array.isArray(result.oneOf) &&
		Array.isArray(result.enum) &&
		result.enum.length > 0
	) {
		const enumTypes = (result.enum as unknown[]).map(inferJsonSchemaTypeFromValue);
		if (enumTypes.every((t): t is string => typeof t === "string") && new Set(enumTypes).size === 1) {
			result.type = enumTypes[0];
		}
	}

	if (options.collapseNullFields && result.type === "null") {
		delete result.type;
		if (!options.stripNullableKeyword) result.nullable = true;
	}

	if (
		options.autoPropertyOrdering &&
		result.type === "object" &&
		!outHasOwn(result, "propertyOrdering") &&
		isRecord(result.properties)
	) {
		const props = result.properties;
		const keys: string[] = [];
		for (const k in props) {
			if (Object.hasOwn(props, k)) keys.push(k);
		}
		if (keys.length > 1) result.propertyOrdering = keys;
	}

	if (options.ensureObjectProperties && result.type === "object" && !outHasOwn(result, "properties")) {
		result.properties = {};
	}

	applyDescriptionSpill(result, spill, options);
	return applyNodePostProcessing(result, options);
}

function applyNodePostProcessing(schema: JsonObject, options: NormalizeSchemaWalkOptions): JsonObject {
	let current = schema;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (options.mergeObjectCombiners) current = mergeObjectCombinerVariants(current, combiner);
		if (options.collapseMixedTypeCombiners) current = collapseMixedTypeCombinerVariants(current, combiner);
		if (options.collapseSameTypeCombiners) current = collapseSameTypeCombinerVariants(current, combiner);
	}
	if (options.foldOneOfIntoAnyOf) current = foldOneOfIntoAnyOf(current);
	if (options.dropNonScalarEnum) current = dropNonScalarEnumForMfjs(current);
	return current;
}

export function foldOneOfIntoAnyOf(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.oneOf)) return schema;
	const rest = copySchemaWithout(schema, "oneOf");
	const existing = Array.isArray(rest.anyOf) ? (rest.anyOf as unknown[]) : [];
	rest.anyOf = existing.concat(schema.oneOf as unknown[]);
	return rest;
}

function dropNonScalarEnumForMfjs(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.enum)) return schema;
	const allScalar = (schema.enum as unknown[]).every(v => typeof v === "string" || typeof v === "number");
	if (allScalar) return schema;
	return copySchemaWithout(schema, "enum");
}

export function copySchemaWithout(schema: JsonObject, combiner: string): JsonObject {
	const { [combiner]: _, ...rest } = schema;
	return rest;
}

function mergeObjectCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isRecord(entry)) {
			return schema;
		}
		const variantType = entry.type;
		const hasObjectShape =
			isRecord(entry.properties) || Array.isArray(entry.required) || Object.hasOwn(entry, "additionalProperties");
		if (variantType === undefined && !hasObjectShape) {
			return schema;
		}
		if (variantType !== undefined && variantType !== "object") {
			return schema;
		}
		if (entry.properties !== undefined && !isRecord(entry.properties)) {
			return schema;
		}
		if (entry.required !== undefined && !Array.isArray(entry.required)) {
			return schema;
		}
		variants.push(entry);
	}

	const mergedProperties: JsonObject = {};
	const ownProperties = isRecord(schema.properties) ? schema.properties : {};
	for (const name in ownProperties) {
		if (Object.hasOwn(ownProperties, name)) mergedProperties[name] = ownProperties[name];
	}

	for (const variant of variants) {
		const properties = isRecord(variant.properties) ? variant.properties : {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const propertySchema = properties[name];
			const existingSchema = mergedProperties[name];
			mergedProperties[name] =
				existingSchema === undefined ? propertySchema : mergePropertySchemas(existingSchema, propertySchema);
		}
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	nextSchema.type = "object";
	nextSchema.properties = mergedProperties;

	let requiredIntersection: string[] | undefined;
	for (const variant of variants) {
		const variantRequired = Array.isArray(variant.required)
			? variant.required.filter((r): r is string => typeof r === "string")
			: [];
		if (requiredIntersection === undefined) {
			requiredIntersection = variantRequired.slice();
		} else {
			const reqSet = new Set(variantRequired);
			requiredIntersection = requiredIntersection.filter(r => reqSet.has(r));
		}
	}
	const parentRequired = Array.isArray(schema.required)
		? schema.required.filter((r): r is string => typeof r === "string")
		: [];
	const safeRequired = new Set<string>();
	for (const name of requiredIntersection ?? []) {
		if (Object.hasOwn(mergedProperties, name)) safeRequired.add(name);
	}
	for (const name of parentRequired) {
		if (Object.hasOwn(ownProperties, name) && Object.hasOwn(mergedProperties, name)) {
			safeRequired.add(name);
		}
	}
	const requiredInPropertyOrder: string[] = [];
	for (const name in mergedProperties) {
		if (Object.hasOwn(mergedProperties, name) && safeRequired.has(name)) requiredInPropertyOrder.push(name);
	}
	if (requiredInPropertyOrder.length > 0) {
		nextSchema.required = requiredInPropertyOrder;
	} else {
		delete nextSchema.required;
	}

	return nextSchema;
}

function collapseMixedTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const seenTypes = new Set<string>();
	const variantTypes: string[] = [];
	const mergedVariantFields: JsonObject = {};
	for (const entry of variantsRaw) {
		if (!isRecord(entry) || typeof entry.type !== "string") {
			return schema;
		}

		const variantType = entry.type;
		if (seenTypes.has(variantType)) {
			return schema;
		}

		const allowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[variantType];
		if (!allowedKeys) {
			return schema;
		}

		for (const key in entry) {
			if (!Object.hasOwn(entry, key)) continue;
			const variantValue = entry[key];
			if (key === "type") continue;
			if (!Object.hasOwn(allowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
				return schema;
			}

			const existingValue = mergedVariantFields[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, variantValue)) {
				if (key !== "description") return schema;
				mergedVariantFields[key] = mergeSchemaDescriptions(existingValue, variantValue);
				continue;
			}
			mergedVariantFields[key] = variantValue;
		}

		seenTypes.add(variantType);
		variantTypes.push(variantType);
	}

	if (variantTypes.length < 2 || variantTypes.every(type => type === "object")) {
		return schema;
	}
	const nextSchema = copySchemaWithout(schema, combiner);
	const nonNullTypes = variantTypes.filter(t => t !== "null");
	const chosenType: string = nonNullTypes[0] ?? variantTypes[0];
	nextSchema.type = chosenType;
	const chosenTypeAllowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[chosenType] ?? {};

	for (const key in nextSchema) {
		if (!Object.hasOwn(nextSchema, key)) continue;
		if (key === "type") continue;
		if (
			Object.hasOwn(ALL_CCA_TYPE_SPECIFIC_KEYS, key) &&
			!Object.hasOwn(chosenTypeAllowedKeys, key) &&
			!Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)
		) {
			delete nextSchema[key];
		}
	}

	for (const key in mergedVariantFields) {
		if (!Object.hasOwn(mergedVariantFields, key)) continue;
		if (!Object.hasOwn(chosenTypeAllowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
			continue;
		}
		const value = mergedVariantFields[key];
		const existingValue = nextSchema[key];
		if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
			if (key !== "description") return schema;
			nextSchema[key] = mergeSchemaDescriptions(existingValue, value);
			continue;
		}
		if (existingValue === undefined) {
			nextSchema[key] = value;
		}
	}
	return nextSchema;
}

function mergeSchemaDescriptions(existing: unknown, incoming: unknown): string {
	if (typeof existing !== "string") return typeof incoming === "string" ? incoming : "";
	if (typeof incoming !== "string" || incoming.length === 0 || existing === incoming) return existing;
	if (existing.length === 0) return incoming;
	return `${existing}\n\n${incoming}`;
}

function collapseSameTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return schema;
	let commonType: string | undefined;
	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isRecord(entry) || typeof entry.type !== "string") return schema;
		if (commonType === undefined) commonType = entry.type;
		else if (entry.type !== commonType) return schema;
		variants.push(entry);
	}
	const firstEntry = variants[0];
	if (!firstEntry) return schema;

	const enumVariantCount = variants.reduce((n, variant) => n + (Array.isArray(variant.enum) ? 1 : 0), 0);

	let collapsed: JsonObject;
	if (enumVariantCount === variants.length) {
		let merged: JsonObject | null = firstEntry;
		for (let i = 1; i < variants.length && merged !== null; i++) {
			merged = mergeCompatibleEnumSchemas(merged, variants[i]);
		}
		if (merged === null) return schema;
		collapsed = merged;
	} else if (enumVariantCount > 0) {
		collapsed = variants.find(variant => !Array.isArray(variant.enum)) ?? firstEntry;
	} else {
		collapsed = firstEntry;
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	for (const key in collapsed) {
		if (Object.hasOwn(collapsed, key) && !outHasOwn(nextSchema, key)) nextSchema[key] = collapsed[key];
	}
	return nextSchema;
}

export function stripResidualCombiners(value: unknown, epoch: number = epochNext()): unknown {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return [];
		return value.map(entry => stripResidualCombiners(entry, epoch));
	}
	if (!isRecord(value)) return value;
	if (!once(value, epoch)) return {};
	const result: JsonObject = {};
	for (const key in value) {
		if (Object.hasOwn(value, key)) result[key] = stripResidualCombiners(value[key], epoch);
	}
	let current: JsonObject = result;
	let changed = true;
	while (changed) {
		changed = false;
		for (const combiner of JSON_SCHEMA_COMBINERS) {
			const sameType = collapseSameTypeCombinerVariants(current, combiner);
			if (sameType !== current) {
				current = sameType;
				changed = true;
			}
			const mixed = collapseMixedTypeCombinerVariants(current, combiner);
			if (mixed !== current) {
				current = mixed;
				changed = true;
			}
		}
	}
	return current;
}

interface NullableExtractionResult {
	schema: unknown;
	nullable: boolean;
}

function extractNullableUnionSchema(schema: unknown): NullableExtractionResult {
	if (!isRecord(schema)) {
		return { schema, nullable: false };
	}

	if (schema.nullable === true) {
		const nextSchema = { ...schema };
		delete nextSchema.nullable;
		return { schema: nextSchema, nullable: true };
	}

	if (Array.isArray(schema.type)) {
		const typeVariants = schema.type.filter((entry): entry is string => typeof entry === "string");
		const nonNullTypes = typeVariants.filter(entry => entry !== "null");
		if (typeVariants.includes("null") && nonNullTypes.length === 1) {
			const nextSchema = { ...schema, type: nonNullTypes[0] };
			return { schema: nextSchema, nullable: true };
		}
	}

	for (const combiner of JSON_SCHEMA_COMBINERS) {
		const variantsRaw = schema[combiner];
		if (!Array.isArray(variantsRaw)) continue;

		let hasNullVariant = false;
		const nonNullVariants: unknown[] = [];
		for (const variant of variantsRaw) {
			if (isRecord(variant) && variant.type === "null") {
				let keyCount = 0;
				for (const k in variant) {
					if (!Object.hasOwn(variant, k)) continue;
					if (++keyCount > 1) break;
				}
				if (keyCount === 1) {
					hasNullVariant = true;
					continue;
				}
			}
			nonNullVariants.push(variant);
		}

		if (!hasNullVariant || nonNullVariants.length !== 1 || !isRecord(nonNullVariants[0])) {
			continue;
		}

		const nextSchema = copySchemaWithout(schema, combiner);
		const nonNullVariant = nonNullVariants[0];
		for (const key in nonNullVariant) {
			if (!Object.hasOwn(nonNullVariant, key)) continue;
			const value = nonNullVariant[key];
			const existingValue = nextSchema[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
				return { schema, nullable: false };
			}
			if (existingValue === undefined) {
				nextSchema[key] = value;
			}
		}
		return { schema: nextSchema, nullable: true };
	}

	return { schema, nullable: false };
}

interface NullableNormalizationResult {
	schema: unknown;
	nullable: boolean;
}

function normalizeNullablePropertiesForCloudCodeAssist(
	value: unknown,
	isPropertySchema = false,
	epoch: number = epochNext(),
): NullableNormalizationResult {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) {
			return { schema: [], nullable: false };
		}
		return {
			schema: value.map(entry => normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch).schema),
			nullable: false,
		};
	}
	if (!isRecord(value)) {
		return { schema: value, nullable: false };
	}
	if (!once(value, epoch)) {
		return { schema: {}, nullable: false };
	}

	const normalized: JsonObject = {};
	for (const key in value) {
		if (Object.hasOwn(value, key))
			normalized[key] = normalizeNullablePropertiesForCloudCodeAssist(value[key], false, epoch).schema;
	}

	if (isRecord(normalized.properties)) {
		const properties = normalized.properties;
		const required = new Set(
			Array.isArray(normalized.required)
				? normalized.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const nextProperties: JsonObject = {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const normalizedProperty = normalizeNullablePropertiesForCloudCodeAssist(properties[name], true, epoch);
			nextProperties[name] = normalizedProperty.schema;
			if (normalizedProperty.nullable) {
				required.delete(name);
			}
		}
		normalized.properties = nextProperties;
		if (Array.isArray(normalized.required)) {
			normalized.required = Array.from(required);
		}
	}

	if (!isPropertySchema) {
		return { schema: normalized, nullable: false };
	}

	return extractNullableUnionSchema(normalized);
}

function createResidualIncompatibilityChecks(
	checks: ReadonlyArray<ResidualSchemaIncompatibility> | undefined,
): ResidualIncompatibilityChecks | undefined {
	if (!checks || checks.length === 0) return undefined;
	const result: ResidualIncompatibilityChecks = {
		typeArray: false,
		typeNull: false,
		nullable: false,
		combiners: false,
	};
	for (const check of checks) {
		switch (check) {
			case "type-array":
				result.typeArray = true;
				break;
			case "type-null":
				result.typeNull = true;
				break;
			case "nullable":
				result.nullable = true;
				break;
			case "combiners":
				result.combiners = true;
				break;
		}
	}
	return result;
}

function hasResidualSchemaIncompatibilities(
	value: unknown,
	checks: ResidualIncompatibilityChecks,
	epoch: number = epochNext(),
): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => hasResidualSchemaIncompatibilities(entry, checks, epoch));
	}
	if (!isRecord(value)) {
		return false;
	}
	if (!once(value, epoch)) {
		return false;
	}

	if (checks.typeArray && Array.isArray(value.type)) return true;
	if (checks.typeNull && value.type === "null") return true;
	if (checks.nullable && Object.hasOwn(value, "nullable")) return true;
	if (checks.combiners) {
		for (const combiner of CCA_FORBIDDEN_COMBINERS) {
			if (Array.isArray(value[combiner])) return true;
		}
	}
	for (const k in value) {
		if (!Object.hasOwn(value, k)) continue;
		if (hasResidualSchemaIncompatibilities(value[k], checks, epoch)) {
			return true;
		}
	}
	return false;
}

export function normalizeSchema(value: unknown, options: NormalizeSchemaOptions): unknown {
	const detoxified = decontaminateZodInstance(value);
	const upgraded = upgradeJsonSchemaTo202012(detoxified);
	const dereferenced = dereferenceJsonSchema(upgraded);
	let normalized = normalizeSchemaNode(dereferenced, {
		...options,
		insideProperties: false,
	});
	if (options.stripResidualCombinersFixpoint) {
		normalized = stripResidualCombiners(normalized);
	}
	if (options.extractNullableFromUnions) {
		normalized = normalizeNullablePropertiesForCloudCodeAssist(normalized).schema;
	}
	const residualChecks = createResidualIncompatibilityChecks(options.rejectResidualIncompatibilities);
	if (residualChecks && hasResidualSchemaIncompatibilities(normalized, residualChecks)) {
		logger.debug("Schema has residual provider incompatibilities, using fallback");
		return options.validateAndFallback?.fallback ?? normalized;
	}
	if (options.validateAndFallback && !isValidJsonSchema(normalized)) {
		logger.debug("Schema failed validation, using fallback");
		return options.validateAndFallback.fallback;
	}
	return normalized;
}

export function normalizeSchemaForGoogle(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: true,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: false,
		autoPropertyOrdering: true,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: false,
		foldOneOfIntoAnyOf: false,
	});
}

export function normalizeSchemaForCCA(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: true,
		collapseSameTypeCombiners: true,
		collapseMixedTypeCombiners: true,
		stripResidualCombinersFixpoint: true,
		extractNullableFromUnions: true,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: false,
		foldOneOfIntoAnyOf: false,
		rejectResidualIncompatibilities: ["type-array", "type-null", "nullable", "combiners"],
		validateAndFallback: { fallback: CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA },
	});
}
