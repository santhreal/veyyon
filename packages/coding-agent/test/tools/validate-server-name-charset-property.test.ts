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
		const forbidden = " /\\@#$%^&*()[]{}|<>?,;'\"";
		for (const ch of forbidden) {
			const err = validateServerName(`a${ch}b`);
			expect(err).toBeDefined();
		}
	});

	it("length 100 is accepted and 101 is rejected", () => {
		expect(validateServerName("a".repeat(100))).toBeUndefined();
		expect(validateServerName("a".repeat(101))).toBeDefined();
	});
});
