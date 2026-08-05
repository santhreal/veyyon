import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode, validateApprovalModeSetting } from "@veyyon/coding-agent/tools/approval";
import {
	APPROVAL_MODE_VALUES,
	DEFAULT_APPROVAL_MODE,
	isKnownApprovalMode,
} from "@veyyon/coding-agent/tools/approval-modes";

/**
 * Approval mode normalization fails closed: typos never become yolo.
 * Exact mode strings and warning copy.
 */

describe("isKnownApprovalMode and APPROVAL_MODE_VALUES", () => {
	it("includes every ladder rung and legacy alias as known modes", () => {
		for (const mode of ["plan", "ask", "ask-command", "auto", "yolo", "always-ask", "write", "auto-edit"] as const) {
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
	/**
	 * An absent `tools.approvalMode` means nothing was configured, so the rung is
	 * whatever a fresh install ships with. It reads the same
	 * `DEFAULT_APPROVAL_MODE` the schema does, so this can never disagree with
	 * the value an unconfigured loader hands back.
	 */
	it("undefined becomes the shipped default", () => {
		expect(normalizeApprovalMode(undefined)).toBe(DEFAULT_APPROVAL_MODE);
		expect(DEFAULT_APPROVAL_MODE).toBe<string>("auto");
	});

	/**
	 * The rung each accepted string lands on. `write` and `auto-edit` are the old
	 * names of the "reads and writes run, commands ask" rung and must both reach
	 * `ask-command`; `always-ask` must reach `ask`.
	 */
	it("known modes map onto the autonomy ladder", () => {
		expect(normalizeApprovalMode("plan")).toBe("plan");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("ask-command")).toBe("ask-command");
		expect(normalizeApprovalMode("auto")).toBe("auto");
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("ask-command");
		expect(normalizeApprovalMode("write")).toBe("ask-command");
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
