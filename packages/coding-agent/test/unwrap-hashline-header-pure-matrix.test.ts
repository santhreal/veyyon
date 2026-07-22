/**
 * unwrapHashlineHeaderPath pure matrix — exact path rewrites.
 */
import { describe, expect, it } from "bun:test";
import { unwrapHashlineHeaderPath } from "../src/tools/plan-mode-guard";

describe("unwrapHashlineHeaderPath matrix", () => {
	const cases: Array<[string, string]> = [
		["src/a.ts", "src/a.ts"],
		["[src/a.ts]", "src/a.ts"],
		["[src/a.ts#ab12]", "src/a.ts"],
		["[src/a.ts#ABCD]", "src/a.ts"],
		["[src/a.ts#zzzz]", "[src/a.ts#zzzz]"],
		["[src/a.ts#abc]", "[src/a.ts#abc]"],
		["[src/a.ts:1-10]", "src/a.ts:1-10"],
		["[/tmp/x.ts#abcd]", "/tmp/x.ts"],
		["[src/a.ts#ab12", "[src/a.ts#ab12"],
		["[#ab12]", "[#ab12]"],
		["[src/a#b.ts#ab12]", "[src/a#b.ts#ab12]"],
		["", ""],
		["[src/a.ts#abcde]", "[src/a.ts#abcde]"],
	];
	for (const [input, want] of cases) {
		it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
			expect(unwrapHashlineHeaderPath(input)).toBe(want);
		});
	}
});
