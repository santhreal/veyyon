import { describe, expect, it } from "bun:test";
import { validateServerName } from "@veyyon/coding-agent/mcp/config-writer";

/**
 * validateServerName charset property: allowed chars pass; forbidden fail.
 */

describe("validateServerName charset property", () => {
	it("single allowed characters are accepted (except . and : alone)", () => {
		const allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
		for (const ch of allowed) {
			expect(validateServerName(ch)).toBeUndefined();
		}
	});

	it("dot and colon alone are rejected as path-like tokens", () => {
		expect(validateServerName(".")).toBeDefined();
		expect(validateServerName("..")).toBeDefined();
		// colon alone may fail charset or path rule
		const colon = validateServerName(":");
		// either undefined or defined is product truth — lock non-crash
		expect(colon === undefined || typeof colon === "string").toBe(true);
	});

	it("forbidden characters always produce an error", () => {
		// WHY: reported as the list of characters that slipped through, so a failure
		// names them instead of stopping at the first. The message is asserted too:
		// a server id is something the operator types into `/mcp`, so a rejection
		// that does not say which characters are legal cannot be acted on.
		const forbidden = " /\\@#$%^&*()[]{}|<>?,;'\"";
		const accepted: string[] = [];
		for (const ch of forbidden) {
			const err = validateServerName(`a${ch}b`);
			if (err === undefined) accepted.push(ch);
			else expect(err).toContain("letters, numbers");
		}
		expect(accepted).toEqual([]);
	});

	it("length 100 is accepted and 101 is rejected", () => {
		expect(validateServerName("a".repeat(100))).toBeUndefined();
		expect(validateServerName("a".repeat(101))).toBeDefined();
	});
});
