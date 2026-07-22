import { describe, expect, it } from "bun:test";
import {
	APPROVAL_MODE_VALUES,
	isKnownApprovalMode,
} from "@veyyon/coding-agent/tools/approval-modes";
import {
	normalizeApprovalMode,
	validateApprovalModeSetting,
} from "@veyyon/coding-agent/tools/approval";

/**
 * Approval mode normalization fails closed: typos never become yolo.
 * Exact mode strings and warning copy.
 */

describe("isKnownApprovalMode and APPROVAL_MODE_VALUES", () => {
	it("includes every ladder + legacy alias as known modes", () => {
		for (const mode of ["plan", "ask", "auto-edit", "yolo", "always-ask", "write"] as const) {
			expect(isKnownApprovalMode(mode)).toBe(true);
			expect(APPROVAL_MODE_VALUES.includes(mode)).toBe(true);
		}
	});

	it("rejects unknown strings and non-strings", () => {
		expect(isKnownApprovalMode("askk")).toBe(false);
		expect(isKnownApprovalMode("Ask")).toBe(false);
		expect(isKnownApprovalMode(" yolo ")).toBe(false);
		expect(isKnownApprovalMode("")).toBe(false);
		expect(isKnownApprovalMode(undefined)).toBe(false);
		expect(isKnownApprovalMode(1)).toBe(false);
		expect(isKnownApprovalMode(null)).toBe(false);
	});
});

describe("normalizeApprovalMode fail-closed", () => {
	it("undefined becomes the documented default yolo", () => {
		expect(normalizeApprovalMode(undefined)).toBe("yolo");
	});

	it("known modes map onto the autonomy ladder", () => {
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("auto-edit");
		expect(normalizeApprovalMode("write")).toBe("auto-edit");
		expect(normalizeApprovalMode("plan")).toBe("plan");
	});

	it("typos and casing fail closed to ask, never yolo", () => {
		// The security fix: unrecognized must NOT become yolo.
		expect(normalizeApprovalMode("askk")).toBe("ask");
		expect(normalizeApprovalMode("Ask")).toBe("ask");
		expect(normalizeApprovalMode("YOLO")).toBe("ask");
		expect(normalizeApprovalMode("yolo ")).toBe("ask");
		expect(normalizeApprovalMode("")).toBe("ask");
		expect(normalizeApprovalMode("banana")).toBe("ask");
	});
});

describe("validateApprovalModeSetting", () => {
	it("returns undefined for known modes and for undefined", () => {
		expect(validateApprovalModeSetting(undefined)).toBeUndefined();
		expect(validateApprovalModeSetting("yolo")).toBeUndefined();
		expect(validateApprovalModeSetting("ask")).toBeUndefined();
	});

	it("returns a warning string for typos that names the bad value", () => {
		const warning = validateApprovalModeSetting("askk");
		expect(typeof warning).toBe("string");
		expect(warning!).toMatch(/askk/i);
		expect(warning!.toLowerCase()).toMatch(/approval|mode|unknown|invalid|ask/i);
	});
});
