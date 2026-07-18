import { describe, expect, it } from "bun:test";
import { formatCliFatal } from "@veyyon/coding-agent/cli";

describe("CLI fatal-error formatting", () => {
	it("prints message + hint only, with no source-context excerpt", () => {
		const err = new Error("No model available for commit generation");
		const out = formatCliFatal(err, { stack: false, colors: false });
		expect(out).toBe(
			"Error: No model available for commit generation\n  (set VEYYON_STACK=1 for the full stack trace)\n",
		);
		// Bun.inspect's source-context render marks excerpt lines with "N | code".
		expect(out).not.toMatch(/^\s*\d+ \|/m);
		expect(out).not.toContain("at <anonymous>");
	});

	it("keeps a non-default error name and walks the cause chain", () => {
		const root = new Error("connect ECONNREFUSED 127.0.0.1:7777");
		const mid = new TypeError("fetch failed");
		mid.cause = root;
		const err = new Error("stats server returned 500");
		err.cause = mid;
		const out = formatCliFatal(err, { stack: false, colors: false });
		expect(out).toContain("Error: stats server returned 500");
		expect(out).toContain("  caused by: TypeError: fetch failed");
		expect(out).toContain("  caused by: connect ECONNREFUSED 127.0.0.1:7777");
	});

	it("stringifies non-Error throwables and non-Error causes", () => {
		expect(formatCliFatal("plain string failure", { stack: false, colors: false })).toContain(
			"Error: plain string failure",
		);
		const err = new Error("outer");
		err.cause = "inner detail";
		expect(formatCliFatal(err, { stack: false, colors: false })).toContain("  caused by: inner detail");
	});

	it("returns the full inspected render when the stack opt-in is set", () => {
		const err = new Error("boom");
		const out = formatCliFatal(err, { stack: true, colors: false });
		expect(out).toContain("boom");
		expect(out).toContain("at ");
		expect(out).not.toContain("(set VEYYON_STACK=1");
	});
});
