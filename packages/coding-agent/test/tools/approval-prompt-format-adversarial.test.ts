import { describe, expect, it } from "bun:test";
import { formatApprovalPrompt, truncateForPrompt } from "@veyyon/coding-agent/tools/approval";

/**
 * formatApprovalPrompt includes tool name and args summary; truncate elides long args.
 */

describe("formatApprovalPrompt adversarial", () => {
	it("includes the tool name in the prompt text", () => {
		const text = formatApprovalPrompt({ name: "bash", approval: "exec" }, { command: "rm -rf /" });
		expect(text.toLowerCase()).toContain("bash");
	});

	it("includes a reason when provided", () => {
		const text = formatApprovalPrompt({ name: "write", approval: "write" }, { path: "/etc/x" }, "outside cwd");
		expect(text.toLowerCase()).toMatch(/outside|cwd|reason|write/);
		expect(text.length).toBeGreaterThan(0);
	});

	it("does not throw on empty args object", () => {
		const text = formatApprovalPrompt({ name: "read", approval: "read" }, {});
		expect(typeof text).toBe("string");
		expect(text.toLowerCase()).toContain("read");
	});

	it("truncateForPrompt of a multi-kb string includes elision marker and prefix", () => {
		const long = `PREFIX${"z".repeat(10_000)}`;
		const out = truncateForPrompt(long, 100);
		expect(out.startsWith("PREFIX")).toBe(true);
		expect(out).toMatch(/elided|…/);
		expect(out.length).toBeLessThan(long.length);
	});

	it("truncateForPrompt maxChars 0 or tiny still returns a string", () => {
		const out = truncateForPrompt("abcdef", 1);
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});
});
