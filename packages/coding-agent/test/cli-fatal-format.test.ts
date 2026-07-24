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

	it("does not hang on a self-referential cause cycle", () => {
		// A wrapped error whose cause is itself once made the cause walk loop
		// forever, hanging the process while printing a fatal error. The walk must
		// terminate and note the cycle instead.
		const err = new Error("self-wrapped failure");
		err.cause = err;
		const out = formatCliFatal(err, { stack: false, colors: false });
		expect(out).toContain("Error: self-wrapped failure");
		expect(out).toContain("  caused by: (circular cause reference)");
		expect(out).toContain("(set VEYYON_STACK=1 for the full stack trace)");
	});

	it("does not hang on a two-error cause cycle and prints each once before stopping", () => {
		// A ↔ B mutual cause chain. Each distinct error is reported exactly once,
		// then the repeat is caught and the walk stops.
		const a = new Error("error A");
		const b = new TypeError("error B");
		a.cause = b;
		b.cause = a;
		const out = formatCliFatal(a, { stack: false, colors: false });
		expect(out).toContain("Error: error A");
		expect(out).toContain("  caused by: TypeError: error B");
		expect(out).toContain("  caused by: (circular cause reference)");
		// "error A" appears once as the head; it is NOT re-printed as its own cause.
		expect(out.match(/error A/g)?.length).toBe(1);
	});

	it("returns the full inspected render when the stack opt-in is set", () => {
		const err = new Error("boom");
		const out = formatCliFatal(err, { stack: true, colors: false });
		expect(out).toContain("boom");
		expect(out).toContain("at ");
		expect(out).not.toContain("(set VEYYON_STACK=1");
	});
});
