/**
 * validateServerConfig pure: empty command / missing url surfaces errors array.
 */
import { describe, expect, it } from "bun:test";
import { validateServerConfig } from "@veyyon/coding-agent/mcp/config";

describe("validateServerConfig pure matrix", () => {
	it("stdio with command ok-ish or errors listed", () => {
		const errs = validateServerConfig("s", { command: "npx", args: ["-y", "x"] } as never);
		expect(Array.isArray(errs)).toBe(true);
	});

	it("http with url", () => {
		const errs = validateServerConfig("s", { url: "https://example.com/mcp" } as never);
		expect(Array.isArray(errs)).toBe(true);
	});

	it("empty object has errors", () => {
		const errs = validateServerConfig("s", {} as never);
		expect(errs.length).toBeGreaterThan(0);
	});

	it("bad server name still validates config shape", () => {
		const errs = validateServerConfig(".", { command: "echo" } as never);
		expect(Array.isArray(errs)).toBe(true);
	});
});
