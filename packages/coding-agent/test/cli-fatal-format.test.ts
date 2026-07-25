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
	describe("an AggregateError reports its members, not just its count", () => {
		/**
		 * The gap this closes, from a real sweep failure. A failed transpile reached
		 * the operator as exactly:
		 *
		 *   AggregateError: 5 errors building ".../auth-storage.ts"
		 *     (set VEYYON_STACK=1 for the full stack trace)
		 *
		 * Bun's aggregate message is a COUNT. All five real errors sat unread in
		 * `err.errors`, which the formatter never looked at because it only walked
		 * `.cause`. Telling someone their build produced five errors and then making
		 * them rerun with an undocumented env var to learn what any of them said is
		 * not reporting a failure, it is announcing one.
		 */
		it("lists each member error under the aggregate", () => {
			const err = new AggregateError(
				[new SyntaxError("Unexpected token at line 12"), new TypeError("cannot read property of undefined")],
				"2 errors building auth-storage.ts",
			);

			const out = formatCliFatal(err, { stack: false, colors: false });

			expect(out).toContain("AggregateError: 2 errors building auth-storage.ts");
			expect(out).toContain("  - SyntaxError: Unexpected token at line 12");
			expect(out).toContain("  - TypeError: cannot read property of undefined");
		});

		it("reports a non-Error member rather than skipping it", () => {
			// A thrown string or object is legal and shows up in real bundler output.
			// Dropping it would under-report the failure count the header promised.
			const err = new AggregateError(["plain string failure", { code: "EBADF" }], "2 failures");

			const out = formatCliFatal(err, { stack: false, colors: false });

			expect(out).toContain("- plain string failure");
			expect(out).toContain("- [object Object]");
		});

		it("caps a huge member list and COUNTS the remainder instead of dropping it", () => {
			// A bundler can aggregate hundreds. Flooding the terminal buries the
			// summary line, but silently truncating would misreport the scale, so the
			// hidden count is stated and points at the full render.
			const members = Array.from({ length: 25 }, (_, i) => new Error(`failure ${i}`));
			const err = new AggregateError(members, "25 errors");

			const out = formatCliFatal(err, { stack: false, colors: false });

			expect(out).toContain("- failure 0");
			expect(out).toContain("- failure 9");
			expect(out).not.toContain("- failure 10");
			expect(out).toContain("- (15 more; set VEYYON_STACK=1 for all of them)");
		});

		it("expands an aggregate that appears as a CAUSE, indented under it", () => {
			// The realistic shape: a friendly wrapper error with the aggregate beneath.
			// If only the head were expanded, the wrapper would hide every detail again.
			const inner = new AggregateError([new Error("missing export foo")], "1 error building bar.ts");
			const err = new Error("failed to start");
			err.cause = inner;

			const out = formatCliFatal(err, { stack: false, colors: false });

			expect(out).toContain("Error: failed to start");
			expect(out).toContain("  caused by: AggregateError: 1 error building bar.ts");
			expect(out).toContain("    - missing export foo");
		});

		it("does not recurse when an aggregate member points back at the aggregate", () => {
			// Same defensive posture as the cause-cycle case: this code runs while the
			// process is already dying, so a hang here costs the operator the error
			// entirely.
			const err = new AggregateError([], "self-referential");
			(err as unknown as { errors: unknown[] }).errors = [err, new Error("real one")];

			const out = formatCliFatal(err, { stack: false, colors: false });

			expect(out).toContain("- real one");
			expect(out.match(/self-referential/g)?.length).toBe(1);
		});

		it("leaves an ordinary Error untouched", () => {
			// The control: no stray bullet list appears for the overwhelmingly common
			// single error.
			const out = formatCliFatal(new Error("just one thing"), { stack: false, colors: false });

			expect(out).toBe("Error: just one thing\n  (set VEYYON_STACK=1 for the full stack trace)\n");
		});

		it("leaves an error whose `errors` property is not an array untouched", () => {
			// `errors` is not reserved; an unrelated error can carry a field by that
			// name, and treating a string as a member list would print garbage.
			const err = new Error("has a field named errors");
			(err as unknown as { errors: unknown }).errors = "not a list";

			const out = formatCliFatal(err, { stack: false, colors: false });

			expect(out).toBe("Error: has a field named errors\n  (set VEYYON_STACK=1 for the full stack trace)\n");
		});
	});
});
