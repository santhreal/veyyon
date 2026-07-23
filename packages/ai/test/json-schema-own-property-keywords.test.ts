import { describe, expect, it } from "bun:test";
import { validateJsonSchemaValue } from "@veyyon/ai/utils/schema";

/**
 * Object-keyword validation must treat an instance property as an OWN property,
 * never as `key in value`. `key in value` also matches every inherited
 * `Object.prototype` member (`toString`, `valueOf`, `constructor`,
 * `hasOwnProperty`, `isPrototypeOf`, …), and a JSON.parse'd instance always
 * carries that prototype. So a schema whose property name collides with a
 * prototype member used to validate against the wrong thing in both directions:
 *
 *   - `required: ["toString"]` PASSED on `{}` because `"toString" in {}` is
 *     true — a required property was never actually enforced (false negative).
 *   - `properties: { toString: { type: "string" } }` on `{}` validated
 *     `Object.prototype.toString` (a function) against the subschema and FAILED
 *     for a property the instance never had (false positive).
 *   - `dependentRequired: { a: ["toString"] }` on `{ a: 1 }` was satisfied
 *     without the object ever carrying `toString`.
 *   - `dependentSchemas: { toString: {...} }` fired its subschema on every
 *     object, because `"toString" in value` is always true.
 *   - the two `additionalProperties` branches disagreed on the instance's key
 *     set: the `false` branch counted own keys (`Object.keys`), the subschema
 *     branch counted inherited enumerable keys (`for...in`).
 *
 * Each test pins the corrected own-property semantics with a concrete instance
 * and asserts the exact success flag and, where relevant, the failing keyword.
 */
describe("JSON Schema object keywords use own-property semantics", () => {
	describe("required", () => {
		it("rejects an object missing a required property named after a prototype member", () => {
			const schema = { type: "object", required: ["toString"] };
			const result = validateJsonSchemaValue(schema, {});
			expect(result.success).toBe(false);
			expect(result.issues.some(issue => issue.keyword === "required")).toBe(true);
		});

		it("accepts an object that owns the prototype-named required property", () => {
			const schema = { type: "object", required: ["toString"] };
			expect(validateJsonSchemaValue(schema, { toString: "present" }).success).toBe(true);
		});

		it("still rejects an ordinary missing required property", () => {
			const schema = { type: "object", required: ["name"] };
			expect(validateJsonSchemaValue(schema, {}).success).toBe(false);
			expect(validateJsonSchemaValue(schema, { name: "x" }).success).toBe(true);
		});
	});

	describe("properties", () => {
		it("does not validate an absent prototype-named property against its subschema", () => {
			// The instance has no own `toString`; the property subschema must not run
			// against the inherited method. Previously this failed because
			// `Object.prototype.toString` (a function) was validated as a string.
			const schema = { type: "object", properties: { toString: { type: "string" } } };
			expect(validateJsonSchemaValue(schema, {}).success).toBe(true);
		});

		it("validates a present prototype-named property normally", () => {
			const schema = { type: "object", properties: { toString: { type: "string" } } };
			expect(validateJsonSchemaValue(schema, { toString: "a string" }).success).toBe(true);
			expect(validateJsonSchemaValue(schema, { toString: 5 }).success).toBe(false);
		});
	});

	describe("dependentRequired", () => {
		it("enforces a prototype-named dependency that the instance does not own", () => {
			// `a` is present, so `toString` is required. The object does not own it,
			// so validation must fail. `"toString" in value` used to hide this.
			const schema = { type: "object", dependentRequired: { a: ["toString"] } };
			expect(validateJsonSchemaValue(schema, { a: 1 }).success).toBe(false);
			expect(validateJsonSchemaValue(schema, { a: 1, toString: "x" }).success).toBe(true);
		});

		it("does not trigger a dependency keyed on an unowned prototype-named property", () => {
			// The trigger key `toString` is not an own property, so the dependency on
			// `b` never activates and the empty object is valid.
			const schema = { type: "object", dependentRequired: { toString: ["b"] } };
			expect(validateJsonSchemaValue(schema, {}).success).toBe(true);
		});
	});

	describe("dependentSchemas", () => {
		it("does not apply a subschema keyed on an unowned prototype-named property", () => {
			// The subschema requires `b`; it must only apply when `toString` is an own
			// property. On a plain object it must not fire, so `{}` is valid.
			const schema = {
				type: "object",
				dependentSchemas: { toString: { required: ["b"] } },
			};
			expect(validateJsonSchemaValue(schema, {}).success).toBe(true);
		});

		it("applies the subschema when the trigger property is genuinely owned", () => {
			const schema = {
				type: "object",
				dependentSchemas: { toString: { required: ["b"] } },
			};
			expect(validateJsonSchemaValue(schema, { toString: "x" }).success).toBe(false);
			expect(validateJsonSchemaValue(schema, { toString: "x", b: 1 }).success).toBe(true);
		});
	});

	describe("additionalProperties branches agree on the instance key set", () => {
		it("counts only own keys under an additionalProperties subschema", () => {
			// An object whose only enumerable string-valued key is INHERITED must not
			// be treated as having an additional property. Before the fix the
			// `for...in` loop walked the inherited key and validated it against the
			// number subschema, failing; the `false` branch (Object.keys) would have
			// passed the same instance. Both branches now agree: own keys only.
			const withInheritedKey = Object.create({ inheritedStr: "not-a-number" }) as Record<string, unknown>;
			const subschemaBranch = {
				type: "object",
				additionalProperties: { type: "number" },
			};
			expect(validateJsonSchemaValue(subschemaBranch, withInheritedKey).success).toBe(true);

			const falseBranch = { type: "object", additionalProperties: false };
			expect(validateJsonSchemaValue(falseBranch, withInheritedKey).success).toBe(true);
		});

		it("still validates a genuine own additional property against the subschema", () => {
			const schema = { type: "object", additionalProperties: { type: "number" } };
			expect(validateJsonSchemaValue(schema, { extra: 7 }).success).toBe(true);
			expect(validateJsonSchemaValue(schema, { extra: "no" }).success).toBe(false);
		});
	});
});
