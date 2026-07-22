/**
 * normalizeApprovalMode rejects case variants and whitespace-padded known modes.
 * Why: only exact lowercase aliases are accepted; typos fail closed to ask.
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode } from "../src/tools/approval";

describe("normalizeApprovalMode case and whitespace reject", () => {
	const bad = [
		"Yolo",
		"YOLO",
		"yolo ",
		" yolo",
		"Plan",
		"PLAN",
		"Ask",
		"ASK",
		"Always-Ask",
		"ALWAYS-ASK",
		"Auto-Edit",
		"AUTO-EDIT",
		"Write",
		"WRITE",
		"yolo\n",
		"\tyolo",
	];

	for (const b of bad) {
		it(`rejects ${JSON.stringify(b)} → ask`, () => {
			expect(normalizeApprovalMode(b)).toBe("ask");
			expect(normalizeApprovalMode(b)).not.toBe("yolo");
		});
	}

	it("exact lowercase still work", () => {
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
		expect(normalizeApprovalMode("plan")).toBe("plan");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("auto-edit");
		expect(normalizeApprovalMode("write")).toBe("auto-edit");
	});
});
