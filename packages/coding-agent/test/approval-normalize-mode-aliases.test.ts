/**
 * normalizeApprovalMode alias and fail-closed matrix expanded.
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode, validateApprovalModeSetting } from "../src/tools/approval";

describe("normalizeApprovalMode alias matrix", () => {
	const map: Array<[string | undefined, string]> = [
		[undefined, "yolo"],
		["plan", "plan"],
		["ask", "ask"],
		["always-ask", "ask"],
		["auto-edit", "auto-edit"],
		["write", "auto-edit"],
		["yolo", "yolo"],
	];
	for (const [input, want] of map) {
		it(`${JSON.stringify(input)} -> ${want}`, () => {
			// normalizeApprovalMode returns the narrow AutonomyLevel union; `want` is a
			// plain string, so widen the matcher to compare their runtime values.
			expect(normalizeApprovalMode(input)).toBe<string>(want);
		});
	}

	const failClosed = [
		"askk",
		"Ask",
		"PLAN",
		"yolo ",
		" plan",
		"default",
		"true",
		"false",
		"0",
		"null",
		"",
		"autoedit",
		"auto_edit",
	];
	for (const bad of failClosed) {
		it(`fail-closed ${JSON.stringify(bad)} -> ask`, () => {
			expect(normalizeApprovalMode(bad)).toBe("ask");
		});
	}
});

describe("validateApprovalModeSetting matrix", () => {
	it("known modes no warning", () => {
		for (const m of ["plan", "ask", "always-ask", "auto-edit", "write", "yolo"]) {
			expect(validateApprovalModeSetting(m)).toBeUndefined();
		}
	});

	it("typos warn with ask fallback", () => {
		const w = validateApprovalModeSetting("askk");
		expect(w).toContain("askk");
		expect(w).toContain('"ask"');
	});
});
