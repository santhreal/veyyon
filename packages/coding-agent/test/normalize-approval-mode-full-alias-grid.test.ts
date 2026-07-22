/**
 * normalizeApprovalMode: every accepted alias and fail-closed unknown → ask.
 * Why: typo modes must not silently stay yolo.
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode } from "../src/tools/approval";

describe("normalizeApprovalMode full alias grid", () => {
	const cases: Array<[string | undefined, string]> = [
		[undefined, "yolo"],
		["yolo", "yolo"],
		["plan", "plan"],
		["ask", "ask"],
		["always-ask", "ask"],
		["auto-edit", "auto-edit"],
		["write", "auto-edit"],
	];

	for (const [input, want] of cases) {
		it(`${JSON.stringify(input)} → ${want}`, () => {
			expect(normalizeApprovalMode(input)).toBe(want);
		});
	}

	const unknowns = [
		"",
		" ",
		"YOLO",
		"Yolo",
		"ASK",
		"always_ask",
		"auto_edit",
		"autoedit",
		"deny",
		"bypass",
		"true",
		"false",
		"0",
		"1",
		"null",
		"undefined",
		"plan ",
		" plan",
		"write-all",
		"full",
		"trusted",
	];
	for (const u of unknowns) {
		it(`unknown ${JSON.stringify(u)} → ask`, () => {
			expect(normalizeApprovalMode(u)).toBe("ask");
		});
	}
});
