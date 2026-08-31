/**
 * unseenLinesMessage empty reveal asks for re-read.
 */
import { describe, expect, it } from "bun:test";
import { unseenLinesMessage } from "../src/messages";

describe("unseenLinesMessage empty reveal", () => {
	it("asks for re-read", () => {
		const m = unseenLinesMessage("f.ts", [1, 2, 3], "ABCD");
		expect(m).toContain("Re-read them in full");
		expect(m).toContain("f.ts:1-3");
		expect(m).not.toContain("straight retry");
	});

	it("default reveal is empty", () => {
		const m = unseenLinesMessage("x.ts", [5], "0000");
		expect(m).toContain("Re-read");
	});
});
