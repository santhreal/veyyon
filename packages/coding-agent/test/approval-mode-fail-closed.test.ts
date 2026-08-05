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
	/**
	 * Locks the schema default and the normalizer on the same rung. `auto` is the
	 * configured default for `tools.approvalMode`, and a caller that reaches the
	 * normalizer with nothing set gets the rung a fresh install ships with, so
	 * the two must not drift: a normalizer answering anything else would hand
	 * unconfigured sessions a different autonomy than the settings screen shows.
	 */
	it("maps undefined to auto, matching the tools.approvalMode schema default", () => {
		expect(normalizeApprovalMode(undefined)).toBe("auto");
	});

	/**
	 * Locks each legacy config value onto the ladder rung that replaced it.
	 * `always-ask` became `ask`, and `write`/`auto-edit` both became
	 * `ask-command`, so an operator who never edits their settings keeps the
	 * autonomy they chose instead of silently sliding up or down the ladder.
	 */
	it("maps known modes and aliases exactly", () => {
		expect(normalizeApprovalMode("plan")).toBe("plan");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("ask-command")).toBe("ask-command");
		expect(normalizeApprovalMode("auto")).toBe("auto");
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("ask-command");
		expect(normalizeApprovalMode("write")).toBe("ask-command");
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
