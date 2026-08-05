/**
 * normalizeApprovalMode: every accepted alias, plus fail-closed unknowns.
 * Why: an unset value takes the shipped default (`auto`), and a typo must fail
 * closed to `ask` rather than inherit that default.
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode } from "../src/tools/approval";

describe("normalizeApprovalMode full alias grid", () => {
	const cases: Array<[string | undefined, string]> = [
		[undefined, "auto"],
		["yolo", "yolo"],
		["plan", "plan"],
		["ask", "ask"],
		["always-ask", "ask"],
		["auto-edit", "ask-command"],
		["write", "ask-command"],
	];

	for (const [input, want] of cases) {
		it(`${JSON.stringify(input)} → ${want}`, () => {
			// normalizeApprovalMode returns the narrow AutonomyLevel union; `want` is a
			// plain string, so widen the matcher to compare their runtime values.
			expect(normalizeApprovalMode(input)).toBe<string>(want);
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
