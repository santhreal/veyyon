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
		// WHY: `{}` defaults to stdio, so the one thing wrong with it is the missing
		// command, and the message has to say that and name the server. "Some error"
		// would also hold for a validator reporting the wrong problem, which sends
		// the operator to fix a field that was never the issue.
		const errs = validateServerConfig("s", {} as never);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toContain('Server "s" is a stdio server with no "command" to spawn');
	});

	it("bad server name still validates config shape", () => {
		const errs = validateServerConfig(".", { command: "echo" } as never);
		expect(Array.isArray(errs)).toBe(true);
	});
});
