/**
 * unwrapHashlineHeaderPath accepts mixed-case 4-hex tags.
 */
import { describe, expect, it } from "bun:test";
import { unwrapHashlineHeaderPath } from "../src/tools/plan-mode-guard";

describe("unwrapHashlineHeaderPath tag case", () => {
	const tags = ["abcd", "ABCD", "AbCd", "aBcD", "12ef", "12EF"];
	for (const tag of tags) {
		it(`tag ${tag}`, () => {
			expect(unwrapHashlineHeaderPath(`[src/x.ts#${tag}]`)).toBe("src/x.ts");
		});
	}

	it("rejects 5 hex", () => {
		expect(unwrapHashlineHeaderPath("[src/x.ts#abcde]")).toBe("[src/x.ts#abcde]");
	});

	it("rejects 3 hex", () => {
		expect(unwrapHashlineHeaderPath("[src/x.ts#abc]")).toBe("[src/x.ts#abc]");
	});
});
