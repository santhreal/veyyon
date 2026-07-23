/**
 * normalizeApprovalMode exhaustive alias table: every accepted string → AutonomyLevel.
 * Why: alias drift (write/auto-edit, always-ask/ask) would flip safety tiers.
 */
import { describe, expect, it } from "bun:test";
import {
	APPROVAL_MODE_VALUES,
	isKnownApprovalMode,
	normalizeApprovalMode,
	validateApprovalModeSetting,
} from "../src/tools/approval";

describe("normalizeApprovalMode exhaustive aliases", () => {
	const table: [string | undefined, string][] = [
		[undefined, "yolo"],
		["yolo", "yolo"],
		["plan", "plan"],
		["ask", "ask"],
		["always-ask", "ask"],
		["auto-edit", "auto-edit"],
		["write", "auto-edit"],
	];

	for (const [input, out] of table) {
		it(`${JSON.stringify(input)} → ${out}`, () => {
			// normalizeApprovalMode returns the narrow AutonomyLevel union; the table's
			// expected value is a plain string, so widen the matcher to compare values.
			expect(normalizeApprovalMode(input)).toBe<string>(out);
		});
	}

	const typos = [
		"Yolo",
		"YOLO",
		"Ask",
		"PLAN",
		"always_ask",
		"autoedit",
		"auto_edit",
		"default",
		"safe",
		"full",
		" ",
		"yolo ",
		" plan",
		"null",
		"undefined",
		"true",
		"false",
		"0",
		"1",
	];

	for (const t of typos) {
		it(`typo ${JSON.stringify(t)} fails closed to ask`, () => {
			expect(normalizeApprovalMode(t)).toBe("ask");
			expect(normalizeApprovalMode(t)).not.toBe("yolo");
		});
	}

	it("APPROVAL_MODE_VALUES all isKnown and validate clean", () => {
		for (const m of APPROVAL_MODE_VALUES) {
			expect(isKnownApprovalMode(m)).toBe(true);
			expect(validateApprovalModeSetting(m)).toBeUndefined();
		}
	});
});
