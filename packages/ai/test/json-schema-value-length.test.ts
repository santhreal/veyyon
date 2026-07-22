import { describe, expect, it } from "bun:test";
import { isJsonSchemaValueValid } from "@veyyon/ai/utils/schema";

/**
 * minLength/maxLength on a `string` schema must count Unicode code points, as
 * JSON Schema 2020-12 specifies, not UTF-16 code units. An astral character (an
 * emoji, a rare CJK ideograph) is a single code point but two UTF-16 units, so
 * a `value.length` check double-counts it and rejects a string that the schema
 * should accept, or accepts one that is really too short. These pin the
 * code-point contract at both bounds so a regression to `.length` fails loudly.
 */
describe("json-schema value length counts code points", () => {
	it("counts a two-code-unit emoji as one character for maxLength", () => {
		const schema = { type: "string", maxLength: 3 };
		// "😀😀😀" is 3 code points but 6 UTF-16 units. A `.length` check saw 6 and
		// wrongly rejected it; the code-point count sees 3 and accepts it.
		expect(isJsonSchemaValueValid(schema, "😀😀😀")).toBe(true);
		// Four emoji is four code points, over the limit of 3.
		expect(isJsonSchemaValueValid(schema, "😀😀😀😀")).toBe(false);
	});

	it("counts a two-code-unit emoji as one character for minLength", () => {
		const schema = { type: "string", minLength: 2 };
		// One emoji is one code point, under the minimum of 2. A `.length` check saw
		// 2 units and wrongly accepted it.
		expect(isJsonSchemaValueValid(schema, "😀")).toBe(false);
		expect(isJsonSchemaValueValid(schema, "😀😀")).toBe(true);
	});

	it("still measures plain ASCII by character at both bounds", () => {
		const schema = { type: "string", minLength: 2, maxLength: 4 };
		expect(isJsonSchemaValueValid(schema, "a")).toBe(false);
		expect(isJsonSchemaValueValid(schema, "ab")).toBe(true);
		expect(isJsonSchemaValueValid(schema, "abcd")).toBe(true);
		expect(isJsonSchemaValueValid(schema, "abcde")).toBe(false);
	});
});
