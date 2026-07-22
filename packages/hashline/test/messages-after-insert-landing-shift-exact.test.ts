/**
 * afterInsertLandingShiftWarning exact string for singular/plural.
 */
import { describe, expect, it } from "bun:test";
import { afterInsertLandingShiftWarning } from "../src/messages";

describe("afterInsertLandingShiftWarning exact", () => {
	it("plural crossed lines", () => {
		expect(afterInsertLandingShiftWarning(20, 24, 3)).toBe(
			"INS.POST 20: body indented shallower than the anchor, so the landing moved past 3 closing lines to after line 24. For the deeper position inside the block, re-issue with the body indented to match.",
		);
	});

	it("singular crossed line", () => {
		expect(afterInsertLandingShiftWarning(1, 2, 1)).toContain("1 closing line");
		expect(afterInsertLandingShiftWarning(1, 2, 1)).not.toContain("1 closing lines");
	});
});
