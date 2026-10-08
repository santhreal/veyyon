import { isRecord } from "@veyyon/utils/type-guards";
import {
	CCA_UNSUPPORTED_SCHEMA_FIELDS,
	COMBINATOR_KEYS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	SCHEMA_MAP_KEYWORDS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import type { JsonObject } from "./types";

/**
 * Schema compatibility audits.
 *
 * Each provider has a different idea of what JSON Schema features it accepts
 * for tool definitions. The normalizers in `normalize.ts`, `strict-mode`,
 * and `adapt.ts` rewrite incoming schemas to fit. This module is the
 * *audit* counterpart: it walks a (presumably already-sanitized) schema and
 * reports any feature the target provider would reject. Tests use it to lock
 * down the contract; the runtime uses it to fail-open with diagnostic logs
 * rather than silently shipping a broken tool definition.
 */
export type SchemaCompatibilityProvider = "openai-strict" | "google" | "cloud-code-assist-claude";

export interface SchemaCompatibilityViolation {
	path: string;
	rule: string;
	message: string;
	key?: string;
	value?: unknown;
}

export interface SchemaCompatibilityResult {
	provider: SchemaCompatibilityProvider;
	compatible: boolean;
	violations: SchemaCompatibilityViolation[];
}

export interface StrictSchemaEnforcementResult {
	schema: Record<string, unknown>;
	strict: boolean;
}

// Per-provider forbidden-key sets. Subsets of the shared `fields.ts` constants
// plus a few provider-specific extras (`const`, `nullable`) folded in here so
// each rule is defined in exactly one place.
const STRICT_FORBIDDEN_KEYS: Record<string, true> = { ...NON_STRUCTURAL_SCHEMA_KEYS, const: true, nullable: true };
const GOOGLE_FORBIDDEN_KEYS: Record<string, true> = { ...UNSUPPORTED_SCHEMA_FIELDS, const: true };
const CCA_FORBIDDEN_KEYS: Record<string, true> = { ...CCA_UNSUPPORTED_SCHEMA_FIELDS, const: true };

// Keys whose values are JSON-Schema *containers* (arrays of values, scalars,
// etc.) rather than nested schemas. The traversal must skip these — recursing
// would walk into `enum` strings or `default` objects and emit spurious
// violations against keys that happen to share JSON-Schema keyword names.
const NON_SCHEMA_CONTAINER_ARRAY_KEYS: Record<string, true> = {
	enum: true,
	required: true,
	examples: true,
	type: true,
};
const NON_SCHEMA_CONTAINER_OBJECT_KEYS: Record<string, true> = { const: true, default: true, example: true };

/** Appends the violations of the schema node at `path` to `violations`. */
type SchemaNodeAudit = (node: JsonObject, path: string, violations: SchemaCompatibilityViolation[]) => void;

function createViolation(
	path: string,
	rule: string,
	message: string,
	key?: string,
	value?: unknown,
): SchemaCompatibilityViolation {
	return {
		path,
		rule,
		message,
		...(key === undefined ? {} : { key }),
		...(value === undefined ? {} : { value }),
	};
}

/**
 * Recursively visit every schema node in a JSON Schema tree, auditing each with `audit`.
 *
 * The walker is *structural*, not type-aware: it knows which keywords contain
 * nested schemas vs. plain values, so it descends into `properties.*`,
 * `$defs.*`, `items`, combinator arrays, etc. but never into `enum`, `const`,
 * `default`, or `type` arrays.
 */
function walkSchema(
	value: unknown,
	path: string,
	audit: SchemaNodeAudit,
	violations: SchemaCompatibilityViolation[],
): void {
	if (Array.isArray(value)) {
		walkSchemaArray(value, path, audit, violations);
		return;
	}
	if (!isRecord(value)) return;
	audit(value, path, violations);
	for (const key in value) walkSchemaKeyword(key, value[key], path, audit, violations);
}

/** Walks each member of `values`, at `path[index]`. */
function walkSchemaArray(
	values: readonly unknown[],
	path: string,
	audit: SchemaNodeAudit,
	violations: SchemaCompatibilityViolation[],
): void {
	for (let index = 0; index < values.length; index++) {
		walkSchema(values[index], `${path}[${index}]`, audit, violations);
	}
}

/** Walks the subschemas held by keyword `key`, with value `entry`, of the node at `path`. */
function walkSchemaKeyword(
	key: string,
	entry: unknown,
	path: string,
	audit: SchemaNodeAudit,
	violations: SchemaCompatibilityViolation[],
): void {
	// Schema-map keywords: value is `{ name: schema, … }`. Recurse into each
	// entry's schema rather than the map object itself.
	if (SCHEMA_MAP_KEYWORDS.has(key)) {
		if (!isRecord(entry)) return;
		for (const name in entry) walkSchema(entry[name], `${path}.${key}.${name}`, audit, violations);
		return;
	}
	// Non-schema container keywords — values are not schemas, do not descend.
	if (key in NON_SCHEMA_CONTAINER_ARRAY_KEYS || key in NON_SCHEMA_CONTAINER_OBJECT_KEYS) return;
	// Array-of-schemas keywords (e.g. `allOf`, `anyOf`, `oneOf`, `prefixItems`).
	if (Array.isArray(entry)) walkSchemaArray(entry, `${path}.${key}`, audit, violations);
	else if (isRecord(entry)) walkSchema(entry, `${path}.${key}`, audit, violations);
}

/** Appends one violation per key of `node` found in `forbidden`, in key order, reading `${message} "<key>"`. */
function appendForbiddenKeys(
	node: JsonObject,
	path: string,
	forbidden: Record<string, true>,
	rule: string,
	message: string,
	violations: SchemaCompatibilityViolation[],
): void {
	for (const key in node) {
		if (key in forbidden) {
			violations.push(createViolation(`${path}.${key}`, rule, `${message} "${key}"`, key, node[key]));
		}
	}
}

/**
 * Strict-mode audit (OpenAI Responses / Codex `strict: true`):
 *  1. Forbid keywords that strict mode disallows (`format`, `pattern`, `const`,
 *     `nullable`, etc. — see `STRICT_FORBIDDEN_KEYS`).
 *  2. Every node must declare *something* concrete: a `type`, a combinator,
 *     a `$ref`, or a `not` branch. Empty `{}` is rejected.
 *  3. Object nodes must set `additionalProperties: false`, declare a real
 *     `properties` map, and require every property in that map. Required
 *     properties not in `properties` are also rejected — strict mode demands
 *     a closed object shape.
 */
function appendStrictViolations(node: JsonObject, path: string, violations: SchemaCompatibilityViolation[]): void {
	appendForbiddenKeys(
		node,
		path,
		STRICT_FORBIDDEN_KEYS,
		"strict-forbidden-key",
		"Strict schema contains forbidden key",
		violations,
	);
	// Rule 2: node must declare at least one concrete shape descriptor.
	if (
		node.type === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(node[key])) &&
		typeof node.$ref !== "string" &&
		!isRecord(node.not)
	) {
		violations.push(
			createViolation(
				path,
				"strict-unrepresentable-node",
				"Strict schema node must declare type, combinator, $ref, or not",
			),
		);
	}
	// Rules 3a-3d apply only to object-shaped nodes.
	if (node.type === "object" || isRecord(node.properties)) appendStrictObjectViolations(node, path, violations);
}

/** Rules 3a-3d of the strict audit, for an object-shaped node. */
function appendStrictObjectViolations(
	node: JsonObject,
	path: string,
	violations: SchemaCompatibilityViolation[],
): void {
	if (node.additionalProperties !== false) {
		violations.push(
			createViolation(
				`${path}.additionalProperties`,
				"strict-object-additional-properties",
				"Strict object schema must set additionalProperties to false",
				"additionalProperties",
				node.additionalProperties,
			),
		);
	}
	// 3b: `properties` must exist and be an object — without it strict mode has nothing to validate.
	if (!isRecord(node.properties)) {
		violations.push(
			createViolation(
				`${path}.properties`,
				"strict-object-properties",
				"Strict object schema must provide an object-valued properties map",
				"properties",
				node.properties,
			),
		);
		return;
	}

	// 3c: every property in `properties` must be required.
	const propertyNames = Object.keys(node.properties);
	const requiredValues = Array.isArray(node.required)
		? node.required.filter((entry): entry is string => typeof entry === "string")
		: [];
	const requiredSet = new Set(requiredValues);
	for (const propertyName of propertyNames) {
		if (requiredSet.has(propertyName)) continue;
		violations.push(
			createViolation(
				`${path}.required`,
				"strict-object-required",
				`Strict object schema must require property "${propertyName}"`,
				"required",
				node.required,
			),
		);
	}
	// 3d: any property declared in `required` but missing from `properties` is unrepresentable.
	const propertyNameSet = new Set(propertyNames);
	for (const requiredKey of requiredValues) {
		if (propertyNameSet.has(requiredKey)) continue;
		violations.push(
			createViolation(
				`${path}.required`,
				"strict-object-required-extra",
				`Strict object schema requires non-existent property "${requiredKey}"`,
				"required",
				node.required,
			),
		);
	}
}

function appendGoogleViolations(node: JsonObject, path: string, violations: SchemaCompatibilityViolation[]): void {
	appendForbiddenKeys(
		node,
		path,
		GOOGLE_FORBIDDEN_KEYS,
		"google-forbidden-key",
		"Google schema contains unsupported key",
		violations,
	);
	if (Array.isArray(node.type)) {
		violations.push(
			createViolation(
				`${path}.type`,
				"google-type-array",
				"Google schema type must be a scalar string, not an array",
				"type",
				node.type,
			),
		);
	}
}

function appendCloudCodeAssistViolations(
	node: JsonObject,
	path: string,
	violations: SchemaCompatibilityViolation[],
): void {
	appendForbiddenKeys(
		node,
		path,
		CCA_FORBIDDEN_KEYS,
		"cca-forbidden-key",
		"Cloud Code Assist schema contains unsupported key",
		violations,
	);

	if (Array.isArray(node.type)) {
		violations.push(
			createViolation(
				`${path}.type`,
				"cca-type-array",
				"Cloud Code Assist schema forbids array-valued type",
				"type",
				node.type,
			),
		);
	}

	if (node.type === "null") {
		violations.push(
			createViolation(
				`${path}.type`,
				"cca-null-type",
				'Cloud Code Assist schema forbids type: "null"',
				"type",
				node.type,
			),
		);
	}

	if (Object.hasOwn(node, "nullable")) {
		violations.push(
			createViolation(
				`${path}.nullable`,
				"cca-nullable-key",
				"Cloud Code Assist schema forbids nullable keyword",
				"nullable",
				node.nullable,
			),
		);
	}

	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(node[key])) {
			violations.push(
				createViolation(
					`${path}.${key}`,
					"cca-combiner",
					`Cloud Code Assist schema forbids ${key}`,
					key,
					node[key],
				),
			);
		}
	}
}

export function validateSchemaCompatibility(
	schema: unknown,
	provider: SchemaCompatibilityProvider,
): SchemaCompatibilityResult {
	const violations: SchemaCompatibilityViolation[] = [];

	switch (provider) {
		case "openai-strict":
			walkSchema(schema, "root", appendStrictViolations, violations);
			break;
		case "google":
			walkSchema(schema, "root", appendGoogleViolations, violations);
			break;
		case "cloud-code-assist-claude":
			walkSchema(schema, "root", appendCloudCodeAssistViolations, violations);
			if (!isValidJsonSchema(schema)) {
				violations.push(
					createViolation(
						"root",
						"cca-meta-schema-validation",
						"Cloud Code Assist schema is not a structurally valid JSON Schema",
					),
				);
			}
			break;
	}

	return {
		provider,
		compatible: violations.length === 0,
		violations,
	};
}

export function validateStrictSchemaEnforcement(
	originalSchema: Record<string, unknown>,
	result: StrictSchemaEnforcementResult,
): SchemaCompatibilityResult {
	if (result.strict) {
		return validateSchemaCompatibility(result.schema, "openai-strict");
	}

	const violations: SchemaCompatibilityViolation[] = [];
	if (result.schema !== originalSchema) {
		violations.push(
			createViolation(
				"root",
				"strict-fail-open-original-schema",
				"Strict fail-open must return the original schema object when strict=false",
			),
		);
	}

	return {
		provider: "openai-strict",
		compatible: violations.length === 0,
		violations,
	};
}
