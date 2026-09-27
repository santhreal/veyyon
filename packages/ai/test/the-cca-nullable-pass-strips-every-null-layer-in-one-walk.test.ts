/**
 * WHY: Cloud Code Assist's nullable pass took one null layer off a property. A property that
 * admitted `null` twice, `nullable: true` beside a combiner with a `{type: "null"}` branch, kept
 * the second layer, the residual check found it, and the whole tool schema fell back to an empty
 * parameter object. The pass also walked every property subtree twice, once as part of its parent
 * map and once as a property, so its cost doubled with each level of nesting.
 *
 * The class this suite closes: a redundant null layer changing a CCA schema. Every combiner, null
 * branch position and branch shape is swept with the property at the root and one object down;
 * adding `nullable: true` must leave the output as it was. The depth case bounds the walk: 22
 * nested objects take about a millisecond walked once per subtree and seconds walked twice per
 * level, so the one-second timeout fails a doubling walk in bounded time.
 *
 * Not caught: a null layer form other than `nullable: true`, a two-type `type` array and a bare
 * `{type: "null"}` combiner branch; the pass recognizes no other.
 */
import { describe, expect, it } from "bun:test";
import { normalizeSchemaForCCA } from "@veyyon/ai/utils/schema";
import { validateSchemaCompatibility } from "@veyyon/ai/utils/schema/compatibility";

type Schema = Record<string, unknown>;

const BRANCHES: Record<string, Schema> = {
	"a number const": { const: 1.5 },
	"a string const": { const: "a" },
	"an integer": { type: "integer", description: "count" },
	"an enum": { enum: [1, 2] },
	"an object": { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
};

function nullableProperty(combiner: "anyOf" | "oneOf", nullFirst: boolean, branch: Schema): Schema {
	return { [combiner]: nullFirst ? [{ type: "null" }, branch] : [branch, { type: "null" }] };
}

function toolSchema(property: Schema, nested: boolean): Schema {
	const params: Schema = { type: "object", properties: { x: property, y: { type: "string" } }, required: ["x", "y"] };
	return nested ? { type: "object", properties: { outer: params }, required: ["outer"] } : params;
}

describe("the CCA nullable pass strips every null layer in one walk", () => {
	for (const combiner of ["anyOf", "oneOf"] as const) {
		for (const nullFirst of [true, false]) {
			for (const [branchName, branch] of Object.entries(BRANCHES)) {
				for (const nested of [false, true]) {
					const where = nested ? "one object down" : "at the root";
					it(`${combiner} of ${branchName}, null ${nullFirst ? "first" : "last"}, ${where}`, () => {
						const once = normalizeSchemaForCCA(toolSchema(nullableProperty(combiner, nullFirst, branch), nested));
						const twice = normalizeSchemaForCCA(
							toolSchema({ ...nullableProperty(combiner, nullFirst, branch), nullable: true }, nested),
						);
						expect(twice).toEqual(once);
						expect(validateSchemaCompatibility(twice, "cloud-code-assist-claude").violations).toEqual([]);
						const params = (nested ? (twice as { properties: Schema }).properties.outer : twice) as Schema;
						expect(Object.keys(params.properties as Schema)).toEqual(["x", "y"]);
					});
				}
			}
		}
	}

	it("keeps a property that admits null twice and drops it from required", () => {
		const prepared = normalizeSchemaForCCA({
			type: "object",
			properties: { x: { oneOf: [{ type: "null" }, { const: 1.5 }], default: true, nullable: true } },
			required: ["x"],
		});
		expect(prepared).toEqual({
			type: "object",
			properties: { x: { default: true, enum: [1.5], type: "number" } },
			required: [],
		});
	});

	it("walks 22 nested objects once each", () => {
		const depth = 22;
		let schema: Schema = { type: "string" };
		for (let level = 0; level < depth; level++) {
			schema = { type: "object", properties: { a: schema, b: { type: "integer" } }, required: ["a", "b"] };
		}
		let prepared = normalizeSchemaForCCA(schema) as Schema;
		for (let level = 0; level < depth; level++) {
			expect(prepared.required).toEqual(["a", "b"]);
			prepared = (prepared.properties as Schema).a as Schema;
		}
		expect(prepared).toEqual({ type: "string" });
	}, 1000);
});
