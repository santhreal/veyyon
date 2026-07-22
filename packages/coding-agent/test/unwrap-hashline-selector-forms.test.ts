/**
 * unwrapHashlineHeaderPath with line selectors and tags.
 */
import { describe, expect, it } from "bun:test";
import { unwrapHashlineHeaderPath } from "../src/tools/plan-mode-guard";

describe("unwrapHashlineHeaderPath selectors", () => {
	it("path:selector without tag peels brackets", () => {
		expect(unwrapHashlineHeaderPath("[src/a.ts:1-10]")).toBe("src/a.ts:1-10");
		expect(unwrapHashlineHeaderPath("[src/a.ts:L5]")).toBe("src/a.ts:L5");
	});

	it("path#tag peels to path", () => {
		expect(unwrapHashlineHeaderPath("[src/a.ts#abcd]")).toBe("src/a.ts");
	});

	it("bare path unchanged", () => {
		expect(unwrapHashlineHeaderPath("src/a.ts:1-10")).toBe("src/a.ts:1-10");
	});
});
