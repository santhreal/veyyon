/**
 * normalizeApprovalMode: undefined → yolo (product default); known modes + aliases exact;
 * unrecognized non-empty → ask (fail closed, never yolo).
 */
import { describe, expect, it } from "bun:test";
import {
	normalizeApprovalMode,
	validateApprovalModeSetting,
} from "@veyyon/coding-agent/tools/approval";

describe("normalizeApprovalMode fail-closed property", () => {
	it("undefined maps to yolo default", () => {
		expect(normalizeApprovalMode(undefined)).toBe("yolo");
	});

	const accepted: Array<[string, string]> = [
		["plan", "plan"],
		["ask", "ask"],
		["always-ask", "ask"],
		["auto-edit", "auto-edit"],
		["write", "auto-edit"],
		["yolo", "yolo"],
	];
	for (const [input, want] of accepted) {
		it(`accepts ${input} → ${want}`, () => {
			expect(normalizeApprovalMode(input)).toBe(want);
		});
	}

	const typos = ["askk", "YOLO", "Yolo", "auto_edit", "autoedit", "full", "deny", "", " ", "null"];
	for (const t of typos) {
		it(`fail-closed ${JSON.stringify(t)} → ask`, () => {
			expect(normalizeApprovalMode(t)).toBe("ask");
		});
	}

	it("no typo maps to yolo except undefined", () => {
		for (const t of ["askk", "bogus", "auto-edit ", " plan", "YOLO"]) {
			expect(normalizeApprovalMode(t)).toBe("ask");
		}
	});
});

describe("validateApprovalModeSetting matrix", () => {
	for (const m of ["plan", "ask", "auto-edit", "yolo", "always-ask", "write"]) {
		it(`ok ${m}`, () => {
			expect(validateApprovalModeSetting(m)).toBeUndefined();
		});
	}

	it("undefined/null ok", () => {
		expect(validateApprovalModeSetting(undefined)).toBeUndefined();
		expect(validateApprovalModeSetting(null)).toBeUndefined();
	});

	it("unrecognized surfaces loudly with fallback wording", () => {
		const w = validateApprovalModeSetting("askk");
		expect(w).toContain("unrecognized");
		expect(w).toContain("askk");
		expect(w).toContain('"ask"');
	});
});
