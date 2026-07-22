/**
 * validateServerConfig error matrix.
 */
import { describe, expect, it } from "bun:test";
import { validateServerConfig } from "../src/mcp/config";

describe("validateServerConfig matrix", () => {
	it("stdio ok", () => {
		expect(validateServerConfig("s", { command: "npx" } as never)).toEqual([]);
	});

	it("stdio missing command", () => {
		const e = validateServerConfig("s", {} as never);
		expect(e.some(x => x.includes("command"))).toBe(true);
	});

	it("http ok", () => {
		expect(validateServerConfig("h", { type: "http", url: "https://x" })).toEqual([]);
	});

	it("http missing url", () => {
		const e = validateServerConfig("h", { type: "http" } as never);
		expect(e.some(x => x.includes("url"))).toBe(true);
	});

	it("sse missing url", () => {
		const e = validateServerConfig("s", { type: "sse" } as never);
		expect(e.some(x => x.includes("url"))).toBe(true);
	});

	it("command+url conflict", () => {
		const e = validateServerConfig("bad", { command: "npx", url: "https://x" } as never);
		expect(e.some(x => x.includes("both"))).toBe(true);
	});
});
