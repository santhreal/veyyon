import { describe, expect, it } from "bun:test";
import { parseArgs } from "@veyyon/coding-agent/cli/args";

describe("parseArgs — --dangerously-skip-permissions flag", () => {
	it("parses --dangerously-skip-permissions as a boolean flag", () => {
		const result = parseArgs(["--dangerously-skip-permissions"]);
		expect(result.dangerouslySkipPermissions).toBe(true);
	});

	it("defaults to undefined when the flag is absent", () => {
		const result = parseArgs(["hello"]);
		expect(result.dangerouslySkipPermissions).toBeUndefined();
	});

	it("does not consume the next argument", () => {
		const result = parseArgs(["--dangerously-skip-permissions", "explain"]);
		expect(result.dangerouslySkipPermissions).toBe(true);
		expect(result.messages).toEqual(["explain"]);
	});

	it("is independent of --yolo (autonomy) auto-approve", () => {
		const result = parseArgs(["--dangerously-skip-permissions"]);
		expect(result.dangerouslySkipPermissions).toBe(true);
		expect(result.autoApprove).toBeUndefined();
	});
});
