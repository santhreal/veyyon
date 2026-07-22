import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode } from "@veyyon/coding-agent/tools/approval";
import { APPROVAL_MODE_VALUES, isKnownApprovalMode } from "@veyyon/coding-agent/tools/approval-modes";

/**
 * normalizeApprovalMode: known modes map correctly; unknowns never become yolo.
 */

describe("normalizeApprovalMode property-style", () => {
	it("every APPROVAL_MODE_VALUES entry normalizes without becoming ask unless typo", () => {
		for (const mode of APPROVAL_MODE_VALUES) {
			const n = normalizeApprovalMode(mode);
			expect(["plan", "ask", "auto-edit", "yolo"]).toContain(n);
			expect(isKnownApprovalMode(mode)).toBe(true);
		}
	});

	it("a large set of typos never normalize to yolo", () => {
		const typos = [
			"askk",
			"Ask",
			"YOLO",
			"yolo ",
			" plan",
			"autoedit",
			"auto_edit",
			"alwaysask",
			"banana",
			"null",
			"0",
			"true",
			"false",
			"read",
			"writee",
		];
		for (const t of typos) {
			expect(normalizeApprovalMode(t)).toBe("ask");
		}
	});

	it("undefined is the only non-string path to yolo default", () => {
		expect(normalizeApprovalMode(undefined)).toBe("yolo");
	});
});
