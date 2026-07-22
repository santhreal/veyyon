import { describe, expect, it } from "bun:test";
import { isJsonSchemaValueValid, validateJsonSchemaValue } from "@veyyon/ai/utils/schema";

/**
 * The `pattern` keyword compiles its regex through a module-level cache so a
 * shared `{ items: { pattern } }` schema does not recompile the identical
 * pattern once per array element. These pin the two things the cache must never
 * change: the regex semantics stay correct across repeated use, and an invalid
 * pattern keeps flagging the schema (not the value) on every element instead of
 * throwing after the first compile.
 *
 * The sharpest regression the cache could introduce is a stateful RegExp. The
 * validator compiles with no flags, so `.test()` is stateless; if a `g` flag
 * ever leaked in, the cached RegExp's `lastIndex` would advance and make the
 * SAME string alternately match and miss across array elements. The
 * many-element cases below would then fail, which is exactly what they guard.
 */
describe("json-schema pattern validation is cached and stateless", () => {
	it("matches an unanchored pattern (JSON Schema partial-match semantics)", () => {
		const schema = { type: "string", pattern: "b" };
		// JSON Schema `pattern` is an unanchored search, so "b" matches anywhere.
		expect(isJsonSchemaValueValid(schema, "abc")).toBe(true);
		expect(isJsonSchemaValueValid(schema, "xyz")).toBe(false);
	});

	it("enforces an anchored pattern exactly", () => {
		const schema = { type: "string", pattern: "^[a-f0-9]{4}$" };
		expect(isJsonSchemaValueValid(schema, "9f3a")).toBe(true);
		expect(isJsonSchemaValueValid(schema, "9f3")).toBe(false);
		expect(isJsonSchemaValueValid(schema, "9f3az")).toBe(false);
	});

	it("gives every element of a shared-pattern array the same verdict", () => {
		// A single item schema validated against many elements exercises the cache:
		// the identical pattern is looked up N times and the reused RegExp must be
		// stateless, so a uniform input yields a uniform result.
		const schema = { type: "array", items: { type: "string", pattern: "^tok-[0-9]+$" } };
		const allValid = Array.from({ length: 50 }, (_, i) => `tok-${i}`);
		expect(isJsonSchemaValueValid(schema, allValid)).toBe(true);

		const oneBad = [...allValid];
		oneBad[37] = "TOK-37"; // uppercase fails the anchored lowercase pattern
		const result = validateJsonSchemaValue(schema, oneBad);
		expect(result.success).toBe(false);
		// Exactly the one offending element is reported, at its index, as a pattern miss.
		const patternIssues = result.issues.filter(issue => issue.keyword === "pattern");
		expect(patternIssues).toHaveLength(1);
		expect(patternIssues[0]?.path).toEqual([37]);
		expect(patternIssues[0]?.message).toBe("must match pattern");
	});

	it("flags an invalid pattern as a schema fault on every element, never throwing", () => {
		// An unterminated group is not a valid regex. The cache stores the compile
		// failure once; each element must still surface "schema pattern is invalid"
		// (the schema is at fault, not the value) rather than a match failure or an
		// uncaught throw on the second and later elements.
		const schema = { type: "array", items: { type: "string", pattern: "(" } };
		const result = validateJsonSchemaValue(schema, ["a", "b", "c"]);
		expect(result.success).toBe(false);
		const patternIssues = result.issues.filter(issue => issue.keyword === "pattern");
		expect(patternIssues).toHaveLength(3);
		for (const issue of patternIssues) {
			expect(issue.message).toBe("schema pattern is invalid");
		}
	});

	it("keeps distinct patterns independent through the cache", () => {
		// Two different pattern strings must not collide in the cache: each keeps
		// its own compiled regex and its own verdict.
		const digits = { type: "string", pattern: "^[0-9]+$" };
		const letters = { type: "string", pattern: "^[a-z]+$" };
		expect(isJsonSchemaValueValid(digits, "123")).toBe(true);
		expect(isJsonSchemaValueValid(digits, "abc")).toBe(false);
		expect(isJsonSchemaValueValid(letters, "abc")).toBe(true);
		expect(isJsonSchemaValueValid(letters, "123")).toBe(false);
	});
});
