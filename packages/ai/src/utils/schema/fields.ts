export const UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
	$schema: true,
	$ref: true,
	$defs: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
	examples: true,
	prefixItems: true,
	unevaluatedProperties: true,
	unevaluatedItems: true,
	patternProperties: true,
	additionalProperties: true,
	propertyNames: true,
	minItems: true,
	maxItems: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	multipleOf: true,
	pattern: true,
	format: true,
};

export const LIFTABLE_TO_DESCRIPTION_FIELDS: Record<string, true> = {
	pattern: true,
	format: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	multipleOf: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	minProperties: true,
	maxProperties: true,
	default: true,
	examples: true,
};

export const NON_STRUCTURAL_SCHEMA_KEYS: Record<string, true> = {
	format: true,
	pattern: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	multipleOf: true,
	$schema: true,
	examples: true,
	default: true,
	title: true,
	$comment: true,
	if: true,
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword
	then: true,
	else: true,
	not: true,
	unevaluatedProperties: true,
	unevaluatedItems: true,
	patternProperties: true,
	propertyNames: true,
	contains: true,
	minContains: true,
	maxContains: true,
	dependentRequired: true,
	dependentSchemas: true,
	contentEncoding: true,
	contentMediaType: true,
	contentSchema: true,
	deprecated: true,
	readOnly: true,
	writeOnly: true,
	minProperties: true,
	maxProperties: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
};

export const CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS: Record<string, Record<string, true>> = {
	array: {
		items: true,
		prefixItems: true,
		contains: true,
		minContains: true,
		maxContains: true,
		minItems: true,
		maxItems: true,
		uniqueItems: true,
		unevaluatedItems: true,
	},
	object: {
		properties: true,
		required: true,
		additionalProperties: true,
		patternProperties: true,
		propertyNames: true,
		minProperties: true,
		maxProperties: true,
		dependentRequired: true,
		dependentSchemas: true,
		unevaluatedProperties: true,
	},
	string: {
		minLength: true,
		maxLength: true,
		pattern: true,
		format: true,
		contentEncoding: true,
		contentMediaType: true,
	},
	number: { minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true },
	integer: { minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true },
	boolean: {},
	null: {},
};

export const ALL_CCA_TYPE_SPECIFIC_KEYS: Record<string, true> = buildAllCcaTypeSpecificKeys();

function buildAllCcaTypeSpecificKeys(): Record<string, true> {
	const all: Record<string, true> = {};
	for (const typeKeys of Object.values(CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS)) {
		for (const key in typeKeys) {
			all[key] = true;
		}
	}
	return all;
}

export const CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS: Record<string, true> = {
	title: true,
	description: true,
	default: true,
	examples: true,
	deprecated: true,
	readOnly: true,
	writeOnly: true,
	$comment: true,
};

export const COMBINATOR_KEYS = ["anyOf", "allOf", "oneOf"] as const;

export const CCA_UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
	$schema: true,
	$ref: true,
	$defs: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
	propertyNames: true,
};
