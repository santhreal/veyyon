/**
 * Body content that looks like Windows paths is opaque string content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits windows-path-style content", () => {
	it("backslash path in body", () => {
		const base = "x";
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n+C:\\\\Users\\\\foo\\\\bar.ts").edits);
		expect(text).toContain("Users");
		expect(text).toContain("bar.ts");
	});

	it("forward slash path in body", () => {
		const base = "old";
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n+/home/user/x.ts").edits);
		expect(text).toBe("/home/user/x.ts");
	});
});
