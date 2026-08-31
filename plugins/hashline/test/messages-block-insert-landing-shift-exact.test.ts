/**
 * blockInsertLandingShiftWarning exact fragments.
 */
import { describe, expect, it } from "bun:test";
import { blockInsertLandingShiftWarning } from "../src/messages";

describe("blockInsertLandingShiftWarning exact", () => {
	it("encodes numbers", () => {
		const m = blockInsertLandingShiftWarning(5, 12, 11);
		expect(m).toContain("INS.BLK.POST 5:");
		expect(m).toContain("closing line 12");
		expect(m).toContain("after line 11");
		expect(m).toContain("INS.POST 12:");
	});
});
