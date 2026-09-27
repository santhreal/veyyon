import { isRecord } from "@veyyon/utils/type-guards";
import { areJsonValuesEqual } from "./equality";
import { epochNext, once } from "./stamps";

/**
 * Hand-rolled JSON Schema meta-validator.
 *
 * Replaces the old AJV meta-schema check in request hot paths with a small
 * structural validator for the JSON Schema subset this repo emits and forwards.
 * Unknown keywords are accepted for forward compatibility; known keywords are
 * checked so malformed provider payloads still fall back instead of being sent.
 */

type Json = unknown;

const TYPE_NAMES: Record<string, true> = {
	string: true,
	number: true,
	integer: true,
	boolean: true,
	object: true,
	array: true,
	null: true,
};

function isNonNegativeInteger(value: Json): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasUniqueJsonValues(values: readonly unknown[]): boolean {
	for (let i = 0; i < values.length; i += 1) {
		for (let j = i + 1; j < values.length; j += 1) {
			if (areJsonValuesEqual(values[i], values[j])) return false;
		}
	}
	return true;
}

function checkTypeKeyword(value: Json): boolean {
	if (typeof value === "string") return value in TYPE_NAMES;
	if (!Array.isArray(value) || value.length === 0) return false;
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !(entry in TYPE_NAMES) || seen.has(entry)) return false;
		seen.add(entry);
	}
	return true;
}

/** Checks one keyword's value; `epoch` stamps the sub-schemas it descends into. */
type KeywordCheck = (value: Json, epoch: number) => boolean;

function checkSchemaArray(value: Json, epoch: number): boolean {
	return Array.isArray(value) && value.every(entry => checkNode(entry, epoch));
}

function checkSchemaMap(value: Json, epoch: number): boolean {
	if (!isRecord(value)) return false;
	for (const k in value) {
		if (!checkNode(value[k], epoch)) return false;
	}
	return true;
}

function checkRequired(value: Json): boolean {
	if (!Array.isArray(value)) return false;
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || seen.has(entry)) return false;
		seen.add(entry);
	}
	return true;
}

function checkDependentRequired(value: Json): boolean {
	if (!isRecord(value)) return false;
	for (const k in value) {
		const entry = value[k];
		if (!Array.isArray(entry) || !entry.every(item => typeof item === "string")) return false;
	}
	return true;
}

function checkPattern(value: Json): boolean {
	if (typeof value !== "string") return false;
	try {
		new RegExp(value);
	} catch {
		// A `pattern` that is not a usable regex makes the schema invalid, which is the question this
		// function answers. False is the verdict, not a swallowed error, and the caller reports the schema
		// as invalid.
		return false;
	}
	return true;
}

const isNumber: KeywordCheck = value => typeof value === "number";
const isBoolean: KeywordCheck = value => typeof value === "boolean";
const isString: KeywordCheck = value => typeof value === "string";
// Obsolete tuple/dependency keywords are not valid in the 2020-12 schema shape we emit and forward.
const obsolete: KeywordCheck = () => false;

/**
 * The check for each known keyword. A node is checked by looking up each of its own keys here, so the cost
 * follows the keys a node has rather than the number of keywords known; a key absent from the table is an
 * unknown keyword and is accepted. A `Map`, so a key such as `constructor` never resolves to an inherited
 * `Object.prototype` member.
 */
const KEYWORD_CHECKS: ReadonlyMap<string, KeywordCheck> = new Map<string, KeywordCheck>([
	["type", checkTypeKeyword],
	["anyOf", checkSchemaArray],
	["oneOf", checkSchemaArray],
	["allOf", checkSchemaArray],
	["prefixItems", checkSchemaArray],
	// Boolean schemas are schemas, so these accept `true` and `false` through `checkNode`. An array is not
	// a schema, so the obsolete tuple form of `items` is rejected here too.
	["not", checkNode],
	["if", checkNode],
	["then", checkNode],
	["else", checkNode],
	["propertyNames", checkNode],
	["contains", checkNode],
	["additionalProperties", checkNode],
	["unevaluatedProperties", checkNode],
	["unevaluatedItems", checkNode],
	["items", checkNode],
	["properties", checkSchemaMap],
	["patternProperties", checkSchemaMap],
	["$defs", checkSchemaMap],
	["definitions", checkSchemaMap],
	["dependentSchemas", checkSchemaMap],
	["required", checkRequired],
	["dependentRequired", checkDependentRequired],
	["additionalItems", obsolete],
	["dependencies", obsolete],
	["enum", value => Array.isArray(value) && value.length > 0 && hasUniqueJsonValues(value)],
	["minimum", isNumber],
	["maximum", isNumber],
	["multipleOf", value => typeof value === "number" && value > 0],
	["exclusiveMinimum", value => typeof value === "number" || typeof value === "boolean"],
	["exclusiveMaximum", value => typeof value === "number" || typeof value === "boolean"],
	["minLength", isNonNegativeInteger],
	["maxLength", isNonNegativeInteger],
	["minItems", isNonNegativeInteger],
	["maxItems", isNonNegativeInteger],
	["minProperties", isNonNegativeInteger],
	["maxProperties", isNonNegativeInteger],
	["minContains", isNonNegativeInteger],
	["maxContains", isNonNegativeInteger],
	["uniqueItems", isBoolean],
	["pattern", checkPattern],
	["format", isString],
	["nullable", isBoolean],
	["readOnly", isBoolean],
	["writeOnly", isBoolean],
	["deprecated", isBoolean],
]);

/** Validate a single sub-schema node. */
function checkNode(node: Json, epoch: number): boolean {
	// Boolean schemas (`true` / `false`) are valid JSON Schema.
	if (node === true || node === false) return true;
	if (!isRecord(node)) return false;
	if (!once(node, epoch)) return true;
	for (const key in node) {
		const check = KEYWORD_CHECKS.get(key);
		if (check !== undefined && !check(node[key], epoch)) return false;
	}
	return true;
}

/** Validate that `schema` is structurally a valid JSON Schema (subset). */
export function isValidJsonSchema(schema: unknown): boolean {
	try {
		return checkNode(schema, epochNext());
	} catch {
		// Fail CLOSED: a schema whose validation blew up (recursion depth, a hostile shape) is treated as
		// invalid rather than accepted, because this gate decides what gets sent to a provider as a tool
		// schema. "Could not prove it valid" must never read as "valid".
		return false;
	}
}
