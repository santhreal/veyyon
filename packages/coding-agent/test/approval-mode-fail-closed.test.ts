/**
 * normalizeApprovalMode fails closed on typos (ask, never yolo).
 * validateApprovalModeSetting surfaces unrecognized values loudly.
 */
import { describe, expect, it } from "bun:test";
import {
	APPROVAL_MODE_VALUES,
	isKnownApprovalMode,
	normalizeApprovalMode,
	validateApprovalModeSetting,
} from "../src/tools/approval";

describe("normalizeApprovalMode", () => {
	it("maps undefined to yolo (documented product default)", () => {
		expect(normalizeApprovalMode(undefined)).toBe("yolo");
	});

	it("maps known modes and aliases exactly", () => {
		expect(normalizeApprovalMode("plan")).toBe("plan");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("auto-edit");
		expect(normalizeApprovalMode("write")).toBe("auto-edit");
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
	});

	it("typos and garbage fail closed to ask, never yolo", () => {
		for (const bad of ["askk", "Ask", " YOLO ", "plan ", "default", "", "null", "true"]) {
			expect(normalizeApprovalMode(bad)).toBe("ask");
			expect(normalizeApprovalMode(bad)).not.toBe("yolo");
		}
	});
});

describe("validateApprovalModeSetting", () => {
	it("undefined/null and known modes yield no warning", () => {
		expect(validateApprovalModeSetting(undefined)).toBeUndefined();
		expect(validateApprovalModeSetting(null)).toBeUndefined();
		for (const m of APPROVAL_MODE_VALUES) {
			expect(validateApprovalModeSetting(m)).toBeUndefined();
			expect(isKnownApprovalMode(m)).toBe(true);
		}
	});

	it("unrecognized values return a loud warning naming ask fallback", () => {
		const w = validateApprovalModeSetting("askk");
		expect(w).toBeDefined();
		expect(w!).toContain("unrecognized");
		expect(w!).toContain("askk");
		expect(w!).toContain('"ask"');
		expect(w!).toContain(APPROVAL_MODE_VALUES[0]!);
	});

	it("non-string unrecognized values also warn", () => {
		expect(validateApprovalModeSetting(42)).toContain("unrecognized");
		expect(validateApprovalModeSetting({})).toContain("unrecognized");
	});
});
