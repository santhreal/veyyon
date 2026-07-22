import { describe, expect, it } from "bun:test";
import { isJTDSchema, jtdToJsonSchema, normalizeSchema } from "@veyyon/coding-agent/tools/jtd-to-json-schema";

describe("jtdToJsonSchema", () => {
	it("converts JTD elements and int32 primitives into JSON Schema", () => {
		const converted = jtdToJsonSchema({
			properties: {
				results: {
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		});
	});

	it("normalizes nested JTD fragments inside JSON Schema nodes", () => {
		const converted = jtdToJsonSchema({
			type: "object",
			properties: {
				results: {
					type: "array",
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
			required: ["results"],
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
		});
	});
	it("does not misinterpret user-named properties that collide with JTD keywords (#1345)", () => {
		// Mirrors the `files[]` shape declared by the built-in explore agent:
		// a JTD elements form whose item properties include one literally named `ref`.
		const converted = jtdToJsonSchema({
			properties: {
				files: {
					elements: {
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				files: {
					type: "array",
					items: {
						type: "object",
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
						required: ["ref", "description"],
						additionalProperties: false,
					},
				},
			},
			required: ["files"],
			additionalProperties: false,
		});
	});
});

/**
 * isJTDSchema decides whether a schema object is written in JTD (so it must be
 * converted) or is already JSON Schema (so it is passed through). A wrong verdict
 * mangles the schema. These cover the detection matrix AND a regression: the
 * detector must use OWN-property checks, not the `in` operator, because
 * `"values" in []` is true via Array.prototype.values, which used to make any
 * array report as a JTD values-form schema.
 */
describe("isJTDSchema", () => {
	it("detects each JTD-only keyword form", () => {
		expect(isJTDSchema({ elements: { type: "string" } })).toBe(true);
		expect(isJTDSchema({ values: { type: "string" } })).toBe(true);
		expect(isJTDSchema({ optionalProperties: {} })).toBe(true);
		expect(isJTDSchema({ discriminator: "kind", mapping: {} })).toBe(true);
		expect(isJTDSchema({ ref: "MyType" })).toBe(true);
	});

	it("detects JTD numeric/timestamp primitives that JSON Schema lacks", () => {
		expect(isJTDSchema({ type: "int32" })).toBe(true);
		expect(isJTDSchema({ type: "float64" })).toBe(true);
		expect(isJTDSchema({ type: "timestamp" })).toBe(true);
	});

	it("treats shared primitives (string, boolean) as NOT JTD-specific", () => {
		expect(isJTDSchema({ type: "string" })).toBe(false);
		expect(isJTDSchema({ type: "boolean" })).toBe(false);
	});

	it("detects a bare properties form (no type) as JTD but a typed object as JSON Schema", () => {
		expect(isJTDSchema({ properties: { a: { type: "string" } } })).toBe(true);
		expect(isJTDSchema({ type: "object", properties: {} })).toBe(false);
	});

	it("returns false for non-object and empty inputs", () => {
		expect(isJTDSchema(null)).toBe(false);
		expect(isJTDSchema("string")).toBe(false);
		expect(isJTDSchema(42)).toBe(false);
		expect(isJTDSchema({})).toBe(false);
	});

	it("returns false for an array, ignoring inherited prototype members like values()", () => {
		// Regression: `"values" in []` is true via Array.prototype.values. The
		// own-property check must keep an array from being seen as a values-form JTD.
		expect(isJTDSchema([])).toBe(false);
		expect(isJTDSchema([{ type: "string" }])).toBe(false);
	});
});

/**
 * normalizeSchema is the input gate in front of the JTD converter: a schema may arrive
 * as an object, a JSON string, or null/undefined. It returns { normalized } on success
 * and { error } when a string fails to parse, so a malformed schema surfaces the parse
 * error instead of throwing or silently vanishing (Law 10). It had no test.
 */
describe("normalizeSchema", () => {
	it("returns an empty result for null or undefined input", () => {
		expect(normalizeSchema(undefined)).toEqual({});
		expect(normalizeSchema(null)).toEqual({});
	});

	it("parses a JSON string into the normalized object", () => {
		expect(normalizeSchema('{"a":1}')).toEqual({ normalized: { a: 1 } });
	});

	it("surfaces a parse error (never a normalized value) for a malformed JSON string", () => {
		const result = normalizeSchema("not json");
		expect(typeof result.error).toBe("string");
		expect(result.error?.length).toBeGreaterThan(0);
		expect(result.normalized).toBeUndefined();
	});

	it("passes a non-string object through by reference with no error", () => {
		const schema = { type: "object" };
		const result = normalizeSchema(schema);
		expect(result.normalized).toBe(schema);
		expect(result.error).toBeUndefined();
	});

	it("passes a non-string, non-object value through as normalized", () => {
		expect(normalizeSchema(5)).toEqual({ normalized: 5 });
	});
});
