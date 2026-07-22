import { describe, expect, it } from "bun:test";
import { magicKeywordRegex } from "@veyyon/coding-agent/modes/magic-keyword-boundary";

/**
 * magicKeywordRegex builds the matcher that decides whether a magic keyword (like
 * "plan") appears as a standalone prose word vs. embedded in code. It must fire on a
 * prose occurrence (surrounded by whitespace, sentence punctuation, or quotes) and
 * must NOT fire when the keyword is welded into an identifier, path segment, file
 * extension, `::` symbol reference, `keyword()` call, or hyphenated token. It is
 * case-sensitive and always compiles with the `u` flag (the boundaries use Unicode
 * property escapes). A regression would either mistake a code reference for a
 * keyword command (false trigger) or miss a real prose mention.
 */

const matches = (keyword: string, text: string): boolean => magicKeywordRegex(keyword).test(text);

describe("magicKeywordRegex prose occurrences (should match)", () => {
	it.each([
		["surrounded by spaces", "use plan here"],
		["at the start of the string", "plan the work"],
		["followed by a period", "make a plan."],
		["followed by a comma", "the plan, then go"],
		["wrapped in quotes", 'the "plan" now'],
		["a period then a space (sentence break)", "plan. Next step"],
	])("matches when %s", (_label, text) => {
		expect(matches("plan", text)).toBe(true);
	});
});

describe("magicKeywordRegex embedded-in-code occurrences (should not match)", () => {
	it.each([
		["a trailing letter (identifier)", "planner runs"],
		["a leading letter (identifier)", "myplan runs"],
		["surrounding underscores", "my_plan_x"],
		["a slash path segment", "src/plan/mod"],
		["a file extension dot", "plan.ts"],
		["a :: symbol reference", "foo::plan"],
		["immediate call parentheses", "plan() call"],
		["a hyphen join", "plan-mode toggle"],
	])("does not match with %s", (_label, text) => {
		expect(matches("plan", text)).toBe(false);
	});
});

describe("magicKeywordRegex flags and escaping", () => {
	it("is case-sensitive", () => {
		expect(matches("plan", "PLAN here")).toBe(false);
	});

	it("always compiles with the unicode flag, adding it to caller flags", () => {
		expect(magicKeywordRegex("plan", "g").flags).toBe("gu");
		expect(magicKeywordRegex("plan", "u").flags).toBe("u");
		expect(magicKeywordRegex("plan").flags).toBe("u");
	});

	it("escapes regex metacharacters in the keyword so a literal dot is matched literally", () => {
		expect(matches("a.b", "use a.b here")).toBe(true);
		expect(matches("a.b", "use axb here")).toBe(false);
	});
});
