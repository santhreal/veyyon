/**
 * Which schemas `isValidJsonSchema` accepts, keyword by keyword.
 *
 * WHY. The meta-validator decides whether a tool schema is sent to a provider as written or replaced by a
 * fallback. It checks a node by looking each of the node's keys up in a table of known keywords and
 * accepting any key the table does not hold. The class this suite closes is a known keyword that stops
 * being checked (dropped from the table, or checked with the wrong rule), a sub-schema keyword that stops
 * descending, and an unknown key that resolves to something that is not a check: a key named after an
 * `Object.prototype` member must be an unknown keyword, never an inherited function.
 *
 * WHAT THIS DOES NOT CATCH. The keyword list below is written out, not read from the validator, so a
 * keyword added to the validator with no row here is unchecked by this suite. Whether a schema accepted
 * here is also accepted by a given provider is `schema-strict-mode.test.ts`'s.
 */

import { describe, expect, it } from "bun:test";
import { isValidJsonSchema } from "@veyyon/ai/utils/schema";

interface KeywordRow {
	readonly valid: readonly unknown[];
	readonly malformed: readonly unknown[];
}

const SCHEMA = { type: "string" };
const MALFORMED_SCHEMA = { type: "bogus" };

const ONE_SCHEMA: KeywordRow = {
	valid: [SCHEMA, true, false, {}],
	malformed: [[], "string", 1, null, MALFORMED_SCHEMA],
};
const SCHEMA_LIST: KeywordRow = {
	valid: [[SCHEMA], [SCHEMA, true], []],
	malformed: [SCHEMA, "string", [1], [MALFORMED_SCHEMA]],
};
const SCHEMA_MAP: KeywordRow = {
	valid: [{ a: SCHEMA, b: true }, {}],
	malformed: [[SCHEMA], "string", { a: 1 }, { a: MALFORMED_SCHEMA }],
};
const NON_NEGATIVE_INTEGER: KeywordRow = { valid: [0, 3], malformed: [-1, 1.5, "3", null] };
const BOOLEAN: KeywordRow = { valid: [true, false], malformed: ["true", 0, null] };
const NUMBER: KeywordRow = { valid: [0, -2.5, 10], malformed: ["0", null, true] };
const EXCLUSIVE_BOUND: KeywordRow = { valid: [0, 1.5, true, false], malformed: ["1", null] };
const OBSOLETE: KeywordRow = { valid: [], malformed: [false, true, [SCHEMA], { a: ["b"] }, SCHEMA] };

const KEYWORDS: Readonly<Record<string, KeywordRow>> = {
	type: {
		valid: ["string", "number", "integer", "boolean", "object", "array", "null", ["string", "null"]],
		malformed: ["bogus", [], ["string", "string"], ["string", 1], 1, null],
	},
	anyOf: SCHEMA_LIST,
	oneOf: SCHEMA_LIST,
	allOf: SCHEMA_LIST,
	prefixItems: SCHEMA_LIST,
	not: ONE_SCHEMA,
	if: ONE_SCHEMA,
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
	then: ONE_SCHEMA,
	else: ONE_SCHEMA,
	propertyNames: ONE_SCHEMA,
	contains: ONE_SCHEMA,
	additionalProperties: ONE_SCHEMA,
	unevaluatedProperties: ONE_SCHEMA,
	unevaluatedItems: ONE_SCHEMA,
	items: ONE_SCHEMA,
	properties: SCHEMA_MAP,
	patternProperties: SCHEMA_MAP,
	$defs: SCHEMA_MAP,
	definitions: SCHEMA_MAP,
	dependentSchemas: SCHEMA_MAP,
	required: { valid: [["a", "b"], []], malformed: [["a", "a"], [1], "a", null] },
	dependentRequired: { valid: [{ a: ["b"] }, { a: [] }, {}], malformed: [{ a: [1] }, { a: "b" }, ["b"], null] },
	additionalItems: OBSOLETE,
	dependencies: OBSOLETE,
	enum: { valid: [["a"], [1, "1"], [{ a: 1 }, { a: 2 }]], malformed: [[], ["a", "a"], [{ a: 1 }, { a: 1 }], "a"] },
	minimum: NUMBER,
	maximum: NUMBER,
	multipleOf: { valid: [1, 0.5], malformed: [0, -1, "2", null] },
	exclusiveMinimum: EXCLUSIVE_BOUND,
	exclusiveMaximum: EXCLUSIVE_BOUND,
	minLength: NON_NEGATIVE_INTEGER,
	maxLength: NON_NEGATIVE_INTEGER,
	minItems: NON_NEGATIVE_INTEGER,
	maxItems: NON_NEGATIVE_INTEGER,
	minProperties: NON_NEGATIVE_INTEGER,
	maxProperties: NON_NEGATIVE_INTEGER,
	minContains: NON_NEGATIVE_INTEGER,
	maxContains: NON_NEGATIVE_INTEGER,
	uniqueItems: BOOLEAN,
	pattern: { valid: ["^a+$", ""], malformed: ["(", 1, null] },
	format: { valid: ["date-time", ""], malformed: [1, null] },
	nullable: BOOLEAN,
	readOnly: BOOLEAN,
	writeOnly: BOOLEAN,
	deprecated: BOOLEAN,
};

/** Keywords whose value is itself a schema, or a list or map of schemas, each wrapped around `inner`. */
const DESCENDING: Readonly<Record<string, (inner: unknown) => unknown>> = {
	anyOf: inner => [inner],
	oneOf: inner => [inner],
	allOf: inner => [inner],
	prefixItems: inner => [inner],
	not: inner => inner,
	if: inner => inner,
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
	then: inner => inner,
	else: inner => inner,
	propertyNames: inner => inner,
	contains: inner => inner,
	additionalProperties: inner => inner,
	unevaluatedProperties: inner => inner,
	unevaluatedItems: inner => inner,
	items: inner => inner,
	properties: inner => ({ a: inner }),
	patternProperties: inner => ({ a: inner }),
	$defs: inner => ({ a: inner }),
	definitions: inner => ({ a: inner }),
	dependentSchemas: inner => ({ a: inner }),
};

describe("a schema keyword", () => {
	for (const [keyword, row] of Object.entries(KEYWORDS)) {
		for (const value of row.valid) {
			it(`${keyword} accepts ${JSON.stringify(value)}`, () => {
				expect(isValidJsonSchema({ [keyword]: value })).toBe(true);
			});
		}
		for (const value of row.malformed) {
			it(`${keyword} rejects ${JSON.stringify(value)}`, () => {
				expect(isValidJsonSchema({ [keyword]: value })).toBe(false);
				expect(isValidJsonSchema({ type: "object", description: "wrapper", [keyword]: value })).toBe(false);
			});
		}
	}

	for (const [keyword, wrap] of Object.entries(DESCENDING)) {
		it(`${keyword} rejects a malformed keyword two levels down`, () => {
			expect(isValidJsonSchema({ [keyword]: wrap({ properties: { deep: { minLength: -1 } } }) })).toBe(false);
			expect(isValidJsonSchema({ [keyword]: wrap({ properties: { deep: { minLength: 1 } } }) })).toBe(true);
		});
	}

	it("is unknown, and accepted, when it names an Object.prototype member", () => {
		for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "toLocaleString"]) {
			expect(isValidJsonSchema({ type: "object", [key]: false })).toBe(true);
			expect(isValidJsonSchema({ type: "object", [key]: { anything: 1 } })).toBe(true);
		}
	});

	it("is unknown, and accepted, when no rule names it", () => {
		expect(isValidJsonSchema({ type: "string", description: 1, title: null, "x-vendor": [1, 1] })).toBe(true);
	});

	it("is checked once on a node two keywords share, and a cycle through it ends", () => {
		const shared: Record<string, unknown> = { type: "object", minProperties: 1 };
		shared.properties = { self: shared };
		expect(isValidJsonSchema({ anyOf: [shared], not: shared, $defs: { a: shared } })).toBe(true);

		const bad: Record<string, unknown> = { type: "object", minProperties: -1 };
		bad.properties = { self: bad };
		expect(isValidJsonSchema({ anyOf: [true], not: { $defs: { a: bad } } })).toBe(false);
	});

	it("leaves a boolean schema valid and any other non-object invalid", () => {
		expect(isValidJsonSchema(true)).toBe(true);
		expect(isValidJsonSchema(false)).toBe(true);
		for (const value of [null, 1, "string", [SCHEMA]]) expect(isValidJsonSchema(value)).toBe(false);
	});
});
