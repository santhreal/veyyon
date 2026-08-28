import { isRecord } from "@veyyon/utils/type-guards";
import { areJsonValuesEqual } from "./equality";
import { epochNext, once } from "./stamps";
import type { JsonObject } from "./types";

export const JSON_SCHEMA_DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

const DRAFT_07_SCHEMA_URIS: Record<string, true> = {
	"http://json-schema.org/draft-07/schema#": true,
	"https://json-schema.org/draft-07/schema#": true,
	"http://json-schema.org/draft-07/schema": true,
	"https://json-schema.org/draft-07/schema": true,
};

const SCHEMA_MAP_KEYS: Record<string, true> = { properties: true, patternProperties: true, dependentSchemas: true };
const NON_SCHEMA_VALUE_KEYS: Record<string, true> = {
	const: true,
	default: true,
	enum: true,
	example: true,
	examples: true,
	required: true,
	dependentRequired: true,
	type: true,
};

function convertRef(value: string): string {
	return value.startsWith("#/definitions/") ? `#/$defs/${value.slice("#/definitions/".length)}` : value;
}

function getObjectMap(target: JsonObject, key: string): JsonObject {
	const existing = target[key];
	if (isRecord(existing)) return existing;
	const next: JsonObject = {};
	target[key] = next;
	return next;
}

function mergeSchemaMap(target: JsonObject, key: string, value: JsonObject, cache: WeakMap<object, unknown>): void {
	const map = getObjectMap(target, key);
	for (const name in value) {
		map[name] = upgradeJsonSchemaTo202012Impl(value[name], cache);
	}
}
function copySchemaMap(target: JsonObject, key: string, value: unknown, cache: WeakMap<object, unknown>): void {
	if (!isRecord(value)) {
		target[key] = value;
		return;
	}
	mergeSchemaMap(target, key, value, cache);
}

function combineSchemas(left: unknown, right: unknown): unknown {
	if (left === undefined || left === true) return right;
	if (right === undefined || right === true) return left;
	if (left === false || right === false) return false;
	if (areJsonValuesEqual(left, right)) return left;
	return { allOf: [left, right] };
}

function mergeArrayValues(left: unknown[], right: unknown[]): unknown[] {
	const merged = left.slice();
	for (const value of right) {
		if (!merged.some(existing => areJsonValuesEqual(existing, value))) {
			merged.push(value);
		}
	}
	return merged;
}

function mergePrefixItems(existing: unknown, convertedItems: unknown[]): unknown[] {
	if (!Array.isArray(existing)) return convertedItems;
	const merged = existing.slice();
	for (let index = 0; index < convertedItems.length; index += 1) {
		merged[index] = index in merged ? combineSchemas(merged[index], convertedItems[index]) : convertedItems[index];
	}
	return merged;
}

function mergeDependentRequired(target: JsonObject, key: string, deps: unknown[]): void {
	const dependentRequired = getObjectMap(target, "dependentRequired");
	const existing = dependentRequired[key];
	if (existing === undefined) {
		dependentRequired[key] = deps;
		return;
	}
	if (Array.isArray(existing)) {
		dependentRequired[key] = mergeArrayValues(existing, deps);
	}
}

function mergeDependentSchema(target: JsonObject, key: string, schema: unknown): void {
	const dependentSchemas = getObjectMap(target, "dependentSchemas");
	dependentSchemas[key] = combineSchemas(dependentSchemas[key], schema);
}

function convertDependencies(source: JsonObject, target: JsonObject, cache: WeakMap<object, unknown>): void {
	const dependencies = source.dependencies;
	if (!isRecord(dependencies)) return;
	for (const key in dependencies) {
		const dependency = dependencies[key];
		const converted = upgradeJsonSchemaTo202012Impl(dependency, cache);
		if (Array.isArray(converted)) {
			mergeDependentRequired(target, key, converted);
		} else {
			mergeDependentSchema(target, key, converted);
		}
	}
}

function hasNullType(type: unknown): boolean {
	return type === "null" || (Array.isArray(type) && type.includes("null"));
}

function hasNullVariant(variants: unknown[]): boolean {
	return variants.some(variant => isRecord(variant) && hasNullType(variant.type));
}

function makeNullable(schema: JsonObject): JsonObject {
	const type = schema.type;
	if (typeof type === "string") {
		if (type !== "null") schema.type = [type, "null"];
		return schema;
	}
	if (Array.isArray(type)) {
		if (!type.includes("null")) schema.type = type.concat(["null"]);
		return schema;
	}
	if (Array.isArray(schema.anyOf)) {
		if (!hasNullVariant(schema.anyOf)) schema.anyOf = schema.anyOf.concat([{ type: "null" }]);
		return schema;
	}
	return { anyOf: [schema, { type: "null" }] };
}

function schemaMapNeedsDraft202012Upgrade(value: unknown, epoch: number): boolean {
	if (!isRecord(value)) return false;
	for (const k in value) {
		if (schemaNeedsDraft202012UpgradeImpl(value[k], epoch)) return true;
	}
	return false;
}

function schemaNeedsDraft202012UpgradeImpl(value: unknown, epoch: number): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => schemaNeedsDraft202012UpgradeImpl(entry, epoch));
	}
	if (!isRecord(value)) return false;
	if (!once(value, epoch)) return false;

	for (const key in value) {
		const entry = value[key];
		if (key === "$schema") {
			if (typeof entry === "string" && entry in DRAFT_07_SCHEMA_URIS) return true;
			continue;
		}
		if (key === "definitions" || key === "dependencies" || key === "additionalItems" || key === "nullable") {
			return true;
		}
		if (key === "$ref") {
			if (typeof entry === "string" && entry.startsWith("#/definitions/")) return true;
			continue;
		}
		if (key === "items" && Array.isArray(entry)) return true;
		if (key === "$defs" || key in SCHEMA_MAP_KEYS) {
			if (schemaMapNeedsDraft202012Upgrade(entry, epoch)) return true;
			continue;
		}
		if (key in NON_SCHEMA_VALUE_KEYS) continue;
		if (schemaNeedsDraft202012UpgradeImpl(entry, epoch)) return true;
	}

	return false;
}

function upgradeJsonSchemaTo202012Impl(value: unknown, cache: WeakMap<object, unknown>): unknown {
	if (Array.isArray(value)) {
		const cached = cache.get(value);
		if (cached !== undefined) return cached;
		const result: unknown[] = [];
		cache.set(value, result);
		for (const entry of value) {
			result.push(upgradeJsonSchemaTo202012Impl(entry, cache));
		}
		return result;
	}
	if (!isRecord(value)) return value;

	const cached = cache.get(value);
	if (cached !== undefined) return cached;

	const result: JsonObject = {};
	cache.set(value, result);
	for (const key in value) {
		const entry = value[key];
		if (key === "definitions" || key === "$defs") {
			if (isRecord(entry)) mergeSchemaMap(result, "$defs", entry, cache);
			continue;
		}
		if (key in SCHEMA_MAP_KEYS) {
			copySchemaMap(result, key, entry, cache);
			continue;
		}
		if (key in NON_SCHEMA_VALUE_KEYS) {
			result[key] = entry;
			continue;
		}
		if (key === "dependencies" || key === "additionalItems" || key === "nullable") {
			continue;
		}
		if (key === "$schema") {
			result.$schema =
				typeof entry === "string" && entry in DRAFT_07_SCHEMA_URIS ? JSON_SCHEMA_DRAFT_2020_12_URI : entry;
			continue;
		}
		if (key === "$ref" && typeof entry === "string") {
			result.$ref = convertRef(entry);
			continue;
		}
		if (key === "items" && Array.isArray(entry)) {
			continue;
		}
		result[key] = upgradeJsonSchemaTo202012Impl(entry, cache);
	}

	if (Array.isArray(value.items)) {
		const convertedItems = upgradeJsonSchemaTo202012Impl(value.items, cache) as unknown[];
		result.prefixItems = mergePrefixItems(result.prefixItems, convertedItems);
		if (value.additionalItems !== undefined && value.additionalItems !== true) {
			result.items = upgradeJsonSchemaTo202012Impl(value.additionalItems, cache);
		} else {
			delete result.items;
		}
	}

	convertDependencies(value, result, cache);

	if (value.nullable === true) {
		const nullable = makeNullable(result);
		if (nullable !== result) cache.set(value, nullable);
		return nullable;
	}

	return result;
}

export function schemaNeedsDraft202012Upgrade(schema: unknown): boolean {
	return schemaNeedsDraft202012UpgradeImpl(schema, epochNext());
}

export function upgradeJsonSchemaTo202012(schema: unknown): unknown {
	if (!schemaNeedsDraft202012Upgrade(schema)) return schema;
	return upgradeJsonSchemaTo202012Impl(schema, new WeakMap<object, unknown>());
}
