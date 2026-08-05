/**
 * normalizeApprovalMode alias and fail-closed matrix expanded.
 *
 * Two separate questions live here. An absent value is "no operator intent",
 * which resolves to the shipped default rung; an unrecognized non-empty value
 * is a typo, which fails closed to `ask` and never up the ladder or to the
 * default.
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode, validateApprovalModeSetting } from "../src/tools/approval";
import { APPROVAL_MODE_VALUES, AUTONOMY_LABEL } from "../src/tools/approval-modes";

describe("normalizeApprovalMode alias matrix", () => {
	const map: Array<[string | undefined, string]> = [
		// A LITERAL, not `DEFAULT_APPROVAL_MODE`. This row used to name the constant, which made the
		// expectation follow the value it exists to pin: with the default set to `yolo` this stayed
		// green while every rung, every tier ceiling and the critical floor were dead for anyone who
		// had not opened /settings. The behavioural half is in
		// `test/approval-ladder-fires-on-a-fresh-install.test.ts`.
		[undefined, "auto"],
		["plan", "plan"],
		["ask", "ask"],
		["always-ask", "ask"],
		["ask-command", "ask-command"],
		["auto-edit", "ask-command"],
		["write", "ask-command"],
		["auto", "auto"],
		["yolo", "yolo"],
	];
	for (const [input, want] of map) {
		it(`${JSON.stringify(input)} -> ${want}`, () => {
			// normalizeApprovalMode returns the narrow AutonomyLevel union; `want` is a
			// plain string, so widen the matcher to compare their runtime values.
			expect(normalizeApprovalMode(input)).toBe<string>(want);
		});
	}

	it("maps every accepted value to a rung on the ladder", () => {
		// AUTONOMY_LABEL is keyed by AutonomyLevel, so it is the ladder itself:
		// an accepted value that normalized to something off the ladder would
		// have no label to show in the status line or /permissions.
		for (const mode of APPROVAL_MODE_VALUES) {
			expect(AUTONOMY_LABEL[normalizeApprovalMode(mode)]).toBeString();
		}
	});

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
		"ask command",
		"askcommand",
	];
	for (const bad of failClosed) {
		it(`fail-closed ${JSON.stringify(bad)} -> ask`, () => {
			expect(normalizeApprovalMode(bad)).toBe("ask");
		});
	}
});

describe("validateApprovalModeSetting matrix", () => {
	it("known modes no warning", () => {
		for (const m of APPROVAL_MODE_VALUES) {
			expect(validateApprovalModeSetting(m)).toBeUndefined();
		}
	});

	it("typos warn with ask fallback", () => {
		const w = validateApprovalModeSetting("askk");
		expect(w).toContain("askk");
		expect(w).toContain('"ask"');
	});
});
