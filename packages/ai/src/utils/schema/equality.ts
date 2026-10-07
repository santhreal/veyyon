import { isRecord } from "@veyyon/utils/type-guards";
import type { JsonObject } from "./types";

export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && areJsonArraysEqual(left, right);
	}
	return isRecord(left) && isRecord(right) && areJsonObjectsEqual(left, right);
}

function areJsonArraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (!areJsonValuesEqual(left[i], right[i])) {
			return false;
		}
	}
	return true;
}

function areJsonObjectsEqual(left: JsonObject, right: JsonObject): boolean {
	let rightLen = 0;
	for (const _ in right) rightLen++;
	let leftLen = 0;
	for (const key in left) {
		leftLen++;
		if (!(key in right) || !areJsonValuesEqual(left[key], right[key])) return false;
	}
	return leftLen === rightLen;
}

/** Number of keys of `schema` other than `enum`. */
function countNonEnumKeys(schema: JsonObject): number {
	let count = 0;
	for (const key in schema) {
		if (key !== "enum") count++;
	}
	return count;
}

/** True when `existing` and `incoming` hold the same keywords with equal values, `enum` aside. */
function haveEqualNonEnumKeywords(existing: JsonObject, incoming: JsonObject): boolean {
	if (countNonEnumKeys(existing) !== countNonEnumKeys(incoming)) {
		return false;
	}
	for (const key in existing) {
		if (key === "enum") continue;
		if (!(key in incoming) || !areJsonValuesEqual(existing[key], incoming[key])) {
			return false;
		}
	}
	return true;
}

/** A copy of `base` followed by each member of `additions` that equals no member already in the result. */
function unionByJsonEquality(base: readonly unknown[], additions: readonly unknown[]): unknown[] {
	const union = base.slice();
	for (const value of additions) {
		if (!union.some(member => areJsonValuesEqual(member, value))) {
			union.push(value);
		}
	}
	return union;
}

export function mergeCompatibleEnumSchemas(existing: unknown, incoming: unknown): JsonObject | null {
	if (!isRecord(existing) || !isRecord(incoming)) {
		return null;
	}
	if (
		!Array.isArray(existing.enum) ||
		!Array.isArray(incoming.enum) ||
		!haveEqualNonEnumKeywords(existing, incoming)
	) {
		return null;
	}
	return {
		...existing,
		enum: unionByJsonEquality(existing.enum, incoming.enum),
	};
}

function getAnyOfVariants(schema: unknown): unknown[] {
	if (isRecord(schema) && Array.isArray(schema.anyOf)) {
		return schema.anyOf;
	}
	return [schema];
}

export function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
	if (areJsonValuesEqual(existing, incoming)) {
		return existing;
	}
	const mergedEnumSchema = mergeCompatibleEnumSchemas(existing, incoming);
	if (mergedEnumSchema !== null) {
		return mergedEnumSchema;
	}

	const mergedAnyOf = unionByJsonEquality(getAnyOfVariants(existing), getAnyOfVariants(incoming));
	return mergedAnyOf.length === 1 ? mergedAnyOf[0] : { anyOf: mergedAnyOf };
}
