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

/**
 * Every JTD primitive maps to exactly one JSON Schema type: `timestamp` is an
 * ISO-8601 string, the float widths collapse to `number`, and the sized
 * integers collapse to `integer`. A regression in the map would let a model
 * emit the wrong JSON type (a float where an integer is required, say).
 */
describe("jtdToJsonSchema — every primitive type", () => {
	const cases: Array<[string, string]> = [
		["boolean", "boolean"],
		["string", "string"],
		["timestamp", "string"],
		["float32", "number"],
		["float64", "number"],
		["int8", "integer"],
		["uint8", "integer"],
		["int16", "integer"],
		["uint16", "integer"],
		["int32", "integer"],
		["uint32", "integer"],
	];
	for (const [jtd, json] of cases) {
		it(`maps ${jtd} to { type: "${json}" }`, () => {
			expect(jtdToJsonSchema({ type: jtd })).toEqual({ type: json });
		});
	}

	it("emits an unrecognized type verbatim rather than dropping it to accept-anything", () => {
		expect(jtdToJsonSchema({ type: "weird" })).toEqual({ type: "weird" });
	});
});

/**
 * The standalone enum, values, ref, and empty forms, plus the discriminator
 * (tagged union) form. The existing suite above covers the elements/properties
 * forms; these complete the matrix so every JTD form has an exact-output test.
 */
describe("jtdToJsonSchema — remaining forms", () => {
	it("keeps a bare enum form as a JSON Schema enum constraint", () => {
		expect(jtdToJsonSchema({ enum: ["r", "g", "b"] })).toEqual({ enum: ["r", "g", "b"] });
	});

	it("converts a values form to an open object with typed additionalProperties", () => {
		expect(jtdToJsonSchema({ values: { type: "float64" } })).toEqual({
			type: "object",
			additionalProperties: { type: "number" },
		});
	});

	it("rewrites a ref to a JSON Schema $ref under $defs", () => {
		expect(jtdToJsonSchema({ ref: "Node" })).toEqual({ $ref: "#/$defs/Node" });
	});

	it("converts an empty schema to the accept-anything empty object", () => {
		expect(jtdToJsonSchema({})).toEqual({});
	});

	it("leaves optionalProperties out of required and omits required entirely when empty", () => {
		const result = jtdToJsonSchema({ optionalProperties: { z: { type: "boolean" } } }) as Record<string, unknown>;
		expect(result).toEqual({
			type: "object",
			properties: { z: { type: "boolean" } },
			additionalProperties: false,
		});
		expect("required" in result).toBe(false);
	});

	it("expands a discriminator to oneOf with a const tag required in every branch", () => {
		expect(
			jtdToJsonSchema({
				discriminator: "kind",
				mapping: {
					a: { properties: { x: { type: "string" } } },
					b: { properties: { y: { type: "int32" } }, optionalProperties: { z: { type: "boolean" } } },
				},
			}),
		).toEqual({
			oneOf: [
				{
					type: "object",
					properties: { x: { type: "string" }, kind: { const: "a" } },
					additionalProperties: false,
					required: ["x", "kind"],
				},
				{
					type: "object",
					properties: { y: { type: "integer" }, z: { type: "boolean" }, kind: { const: "b" } },
					additionalProperties: false,
					required: ["y", "kind"],
				},
			],
		});
	});

	it("force-adds only the discriminator tag to required, leaving a branch's optional field optional", () => {
		expect(
			jtdToJsonSchema({
				discriminator: "kind",
				mapping: { a: { optionalProperties: { x: { type: "string" } } } },
			}),
		).toEqual({
			oneOf: [
				{
					type: "object",
					properties: { x: { type: "string" }, kind: { const: "a" } },
					additionalProperties: false,
					required: ["kind"],
				},
			],
		});
	});
});

/**
 * Regression: a `nullable: true` sibling was silently dropped on every converted
 * form, so a nullable JTD value became a NON-nullable JSON Schema and a model's
 * valid `null` failed validation (a silent narrowing, Law 10). JSON Schema has
 * no `nullable` keyword, so null-ness must be folded into the shape itself: a
 * `type` gains `"null"` in a type array, an `enum` gains a `null` member, and a
 * shape with no extendable type (a `$ref`, a discriminator's `oneOf`) is wrapped
 * in `anyOf` with a `{ type: "null" }` branch.
 */
describe("jtdToJsonSchema — nullable keyword", () => {
	it("adds null to a primitive type as a type array", () => {
		expect(jtdToJsonSchema({ type: "int32", nullable: true })).toEqual({ type: ["integer", "null"] });
	});

	it("adds null to an elements array type", () => {
		expect(jtdToJsonSchema({ elements: { type: "string" }, nullable: true })).toEqual({
			type: ["array", "null"],
			items: { type: "string" },
		});
	});

	it("adds null to a values object type", () => {
		expect(jtdToJsonSchema({ values: { type: "int32" }, nullable: true })).toEqual({
			type: ["object", "null"],
			additionalProperties: { type: "integer" },
		});
	});

	it("adds null to a properties object type", () => {
		expect(jtdToJsonSchema({ nullable: true, properties: { a: { type: "string" } } })).toEqual({
			type: ["object", "null"],
			properties: { a: { type: "string" } },
			additionalProperties: false,
			required: ["a"],
		});
	});

	it("adds a null member to an enum", () => {
		expect(jtdToJsonSchema({ enum: ["a", "b"], nullable: true })).toEqual({ enum: ["a", "b", null] });
	});

	it("wraps a ref in anyOf with a null branch (no type to extend)", () => {
		expect(jtdToJsonSchema({ ref: "Node", nullable: true })).toEqual({
			anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }],
		});
	});

	it("wraps a discriminator oneOf in anyOf with a null branch", () => {
		expect(
			jtdToJsonSchema({
				nullable: true,
				discriminator: "k",
				mapping: { a: { properties: { x: { type: "string" } } } },
			}),
		).toEqual({
			anyOf: [
				{
					oneOf: [
						{
							type: "object",
							properties: { x: { type: "string" }, k: { const: "a" } },
							additionalProperties: false,
							required: ["x", "k"],
						},
					],
				},
				{ type: "null" },
			],
		});
	});

	it("is a no-op when nullable is false", () => {
		expect(jtdToJsonSchema({ type: "int32", nullable: false })).toEqual({ type: "integer" });
	});
});

/**
 * Regression: JTD keeps human-facing text under `metadata.description`, and it
 * used to be dropped during conversion, so a model lost the guidance the schema
 * author wrote. JSON Schema uses a top-level `description`, so the string must
 * be lifted onto every converted node (and only a string; an existing
 * `description` is never overwritten).
 */
describe("jtdToJsonSchema — metadata.description", () => {
	it("lifts metadata.description onto a primitive node", () => {
		expect(jtdToJsonSchema({ type: "int32", metadata: { description: "an int" } })).toEqual({
			type: "integer",
			description: "an int",
		});
	});

	it("lifts metadata.description onto an object and its nested property", () => {
		expect(
			jtdToJsonSchema({
				metadata: { description: "a thing" },
				properties: { n: { type: "int32", metadata: { description: "count" } } },
			}),
		).toEqual({
			type: "object",
			properties: { n: { type: "integer", description: "count" } },
			additionalProperties: false,
			required: ["n"],
			description: "a thing",
		});
	});

	it("lifts metadata.description onto a bare enum node", () => {
		expect(jtdToJsonSchema({ enum: ["a"], metadata: { description: "letters" } })).toEqual({
			enum: ["a"],
			description: "letters",
		});
	});

	it("ignores a non-string metadata.description", () => {
		expect(jtdToJsonSchema({ type: "int32", metadata: { description: 42 } })).toEqual({ type: "integer" });
	});
});

/**
 * Documented limitation: `{ type: "string", nullable: true }` is ambiguous with
 * OpenAPI, and `string`/`boolean` are the two JTD primitives byte-identical to
 * JSON Schema types, so isJTDSchema deliberately does not claim them (claiming a
 * sibling `type: "object"` would drop its fields). Such input passes through
 * unconverted today. This pins that behavior so any future change is a conscious
 * decision, not an accident.
 */
describe("jtdToJsonSchema — nullable on a bare shared primitive passes through", () => {
	it("passes a bare nullable string through unchanged", () => {
		expect(jtdToJsonSchema({ type: "string", nullable: true })).toEqual({ type: "string", nullable: true });
	});

	it("passes a bare nullable boolean through unchanged", () => {
		expect(jtdToJsonSchema({ type: "boolean", nullable: true })).toEqual({ type: "boolean", nullable: true });
	});
});

/**
 * The bare-enum detection added to isJTDSchema must not disturb a JSON Schema
 * enum constraint (which rides a sibling `type`): converting that would drop the
 * type. A bare enum, by contrast, is claimed so its nullable/metadata siblings
 * fold in correctly.
 */
describe("isJTDSchema — bare enum vs typed enum constraint", () => {
	it("claims a bare enum but not an enum with a sibling type", () => {
		expect(isJTDSchema({ enum: ["a", "b"] })).toBe(true);
		expect(isJTDSchema({ type: "string", enum: ["a", "b"] })).toBe(false);
	});

	it("leaves a JSON Schema enum constraint untouched (keeps its type)", () => {
		expect(jtdToJsonSchema({ type: "string", enum: ["a", "b"] })).toEqual({ type: "string", enum: ["a", "b"] });
	});
});
