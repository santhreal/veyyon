import { describe, expect, it } from "bun:test";
import { validateJsonSchemaValue } from "@veyyon/ai/utils/schema/json-schema-validator";

/**
 * WHY: the value validator walks one mutable instance path. A step pushes a child key before it
 * descends and pops it after, and an issue copies the path when it is recorded. Three defects share
 * that mechanism: a descent that does not pop leaves its key in front of every later sibling's
 * issue, an issue that keeps the live array instead of a copy reads whatever the path holds when the
 * walk ends, and a union that measures its own depth from a path a branch left longer tags the wrong
 * issues `fromUnionBranch`, which the argument-coercion layer reads to decide whether a type repair
 * is authoritative.
 *
 * Each case below puts a failing descent first and a sibling issue after it, for every keyword that
 * descends into a child or records an issue at one, and pins the exact path of every issue.
 *
 * GAP: the table is written out, not read from the validator, which exports no keyword list. A new
 * descending keyword is covered only once a row is added for it.
 */

interface PathCase {
	name: string;
	schema: unknown;
	value: unknown;
	issues: Array<[PropertyKey[], string]>;
}

const CASES: PathCase[] = [
	{
		name: "properties",
		schema: { properties: { a: { type: "string" } }, minProperties: 3 },
		value: { a: 1 },
		issues: [
			[["a"], "type"],
			[[], "minProperties"],
		],
	},
	{
		name: "patternProperties",
		schema: { patternProperties: { "^x": { type: "string" } }, maxProperties: 0 },
		value: { xa: 1 },
		issues: [
			[["xa"], "type"],
			[[], "maxProperties"],
		],
	},
	{
		name: "additionalProperties schema",
		schema: { properties: {}, additionalProperties: { type: "string" }, minProperties: 2 },
		value: { q: 1 },
		issues: [
			[["q"], "type"],
			[[], "minProperties"],
		],
	},
	{
		name: "additionalProperties false after required",
		schema: { additionalProperties: false, required: ["r"] },
		value: { q: 1 },
		issues: [
			[["r"], "required"],
			[["q"], "additionalProperties"],
		],
	},
	{
		name: "propertyNames",
		schema: { propertyNames: { minLength: 3 }, minProperties: 2 },
		value: { ab: 1 },
		issues: [
			[["ab"], "minLength"],
			[[], "minProperties"],
		],
	},
	{
		name: "dependentRequired",
		schema: { dependentRequired: { a: ["b"] }, maxProperties: 0 },
		value: { a: 1 },
		issues: [
			[["b"], "dependentRequired"],
			[[], "maxProperties"],
		],
	},
	{
		name: "dependentSchemas, one untriggered",
		schema: {
			dependentSchemas: { a: { properties: { a: { type: "string" } } }, b: { required: ["c"] } },
			maxProperties: 0,
		},
		value: { a: 1 },
		issues: [
			[["a"], "type"],
			[[], "maxProperties"],
		],
	},
	{
		name: "prefixItems then items",
		schema: { prefixItems: [{ type: "string" }], items: { type: "boolean" }, contains: { type: "null" } },
		value: [1, 2],
		issues: [
			[[0], "type"],
			[[1], "type"],
			[[], "contains"],
		],
	},
	{
		name: "uniqueItems then items",
		schema: { uniqueItems: true, items: { type: "string" }, maxItems: 1 },
		value: [1, 1],
		issues: [
			[[], "maxItems"],
			[[1], "uniqueItems"],
			[[0], "type"],
			[[1], "type"],
		],
	},
	{
		name: "contains discards its element issues",
		schema: { contains: { type: "string", minLength: 5 }, maxItems: 1 },
		value: ["a", 1],
		issues: [
			[[], "maxItems"],
			[[], "contains"],
		],
	},
	{
		name: "nested descent",
		schema: { properties: { a: { items: { properties: { b: { type: "string" } } } } }, required: ["z"] },
		value: { a: [{ b: 1 }, { b: 2 }] },
		issues: [
			[["z"], "required"],
			[["a", 0, "b"], "type"],
			[["a", 1, "b"], "type"],
		],
	},
	{
		name: "$ref at two siblings",
		schema: { $defs: { s: { type: "string" } }, properties: { a: { $ref: "#/$defs/s" }, b: { $ref: "#/$defs/s" } } },
		value: { a: 1, b: 2 },
		issues: [
			[["a"], "type"],
			[["b"], "type"],
		],
	},
	{
		name: "$ref at seventy siblings unwinds its depth after each",
		schema: { $defs: { s: { type: "string" } }, items: { $ref: "#/$defs/s" } },
		value: [...Array.from({ length: 69 }, () => "a"), 1],
		issues: [[[69], "type"]],
	},
	{
		name: "allOf descent before the object keywords",
		schema: { allOf: [{ properties: { a: { type: "string" } } }], required: ["z"] },
		value: { a: 1 },
		issues: [
			[["a"], "type"],
			[["z"], "required"],
		],
	},
];

describe("a validation issue names the value that failed", () => {
	for (const testCase of CASES) {
		it(`records every issue at its own path after a failing descent: ${testCase.name}`, () => {
			const result = validateJsonSchemaValue(testCase.schema, testCase.value);

			expect(result.success).toBe(false);
			expect(result.issues.map(issue => [issue.path, issue.keyword])).toEqual(testCase.issues);
		});
	}

	it("tags only the failed union branch's issues at the union's own path", () => {
		const schema = {
			properties: {
				u: { anyOf: [{ type: "object", properties: { k: { type: "string" } } }, { type: "string" }] },
			},
		};

		const atUnion = validateJsonSchemaValue(schema, { u: 5 });
		const belowUnion = validateJsonSchemaValue(schema, { u: { k: 1 } });

		expect(atUnion.issues).toEqual([
			{
				path: ["u"],
				message: "expected object, received integer",
				keyword: "type",
				expectedTypes: ["object"],
				fromUnionBranch: true,
			},
		]);
		expect(belowUnion.issues).toEqual([
			{ path: ["u", "k"], message: "expected string, received integer", keyword: "type", expectedTypes: ["string"] },
		]);
	});
});
