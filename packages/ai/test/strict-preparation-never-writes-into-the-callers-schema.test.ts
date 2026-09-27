/**
 * WHY: folding `const` into an existing `enum` pushed the value onto the caller's `enum` array.
 * Preparing a tool schema for strict mode changed the tool's own schema (`{enum: ["a", "b"],
 * const: "c"}` came back with `"c"` in its enum), and a frozen `enum` threw, which dropped the
 * tool to non-strict mode.
 *
 * The class this suite closes: any write into the input graph by `sanitizeSchemaForStrictMode` or
 * `tryEnforceStrictSchema`. Every rewrite form is placed under every container and prepared twice:
 * mutable, where the input must equal its snapshot afterwards, and deep-frozen, where a write
 * throws. Both preparations must produce the same result, and `tryEnforceStrictSchema` must reach
 * strict mode for every pair, so a fixture that falls back before sanitizing turns the suite red.
 *
 * Not caught: a write reached only through a rewrite form missing from `STRICT_REWRITE_FORMS`, and
 * a write to a non-enumerable symbol key, which is how the schema walkers stamp their memo slots.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeSchemaForStrictMode, tryEnforceStrictSchema } from "@veyyon/ai/utils/schema";
import { type Schema, STRICT_CONTAINERS, STRICT_REWRITE_FORMS, withStrictRefDefs } from "./helpers/strict-schema-forms";

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

const PREPARATIONS: Record<string, (schema: Schema) => unknown> = {
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema: schema => {
		const prepared = tryEnforceStrictSchema(schema);
		expect(prepared.strict).toBe(true);
		return prepared;
	},
};

describe("strict preparation never writes into the caller's schema", () => {
	for (const [preparationName, prepare] of Object.entries(PREPARATIONS)) {
		for (const [formName, form] of Object.entries(STRICT_REWRITE_FORMS)) {
			for (const [containerName, container] of Object.entries(STRICT_CONTAINERS)) {
				it(`${preparationName}: ${formName} under ${containerName}`, () => {
					const build = () => withStrictRefDefs(container(form()));
					const input = build();
					const snapshot = structuredClone(input);
					const prepared = prepare(input);
					expect(input).toEqual(snapshot);
					expect(prepare(deepFreeze(build()))).toEqual(prepared);
				});
			}
		}
	}

	it("a const outside its enum joins the enum of the sanitized node", () => {
		expect(sanitizeSchemaForStrictMode({ type: "string", enum: ["a", "b"], const: "c" })).toEqual({
			type: "string",
			enum: ["a", "b", "c"],
		});
	});

	it("a const inside its enum leaves the enum as written", () => {
		expect(sanitizeSchemaForStrictMode({ type: "string", enum: ["a", "b"], const: "b" })).toEqual({
			type: "string",
			enum: ["a", "b"],
		});
	});

	it("a frozen enum beside a const outside it still prepares for strict mode", () => {
		const schema = deepFreeze({
			type: "object",
			properties: { mode: { type: "string", enum: ["a", "b"], const: "c" } },
			required: ["mode"],
		});
		expect(tryEnforceStrictSchema(schema)).toEqual({
			strict: true,
			schema: {
				type: "object",
				properties: { mode: { type: "string", enum: ["a", "b", "c"] } },
				required: ["mode"],
				additionalProperties: false,
			},
		});
	});
});
