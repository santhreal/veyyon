import { describe, expect, it } from "bun:test";
import { resolveToolGate } from "./helpers/requires-tool";

/**
 * A suite gated on an external tool must never disappear quietly.
 *
 * The bug this locks out cost real coverage silently. `describe.skipIf(!HAS_JULIA)`
 * turned the Julia eval suite off on every developer machine on this fleet, none
 * of which has julia, and said nothing: a local run reported `2 skip / 0 fail`
 * and looked exactly like a clean run. Coverage can disappear that way and stay
 * gone for months.
 *
 * Two contracts follow, and both are asserted on exact text rather than on
 * shape, because "it printed something" is precisely the standard that let a
 * silent skip through in the first place. An environment declares the tools it
 * provides through `VEYYON_REQUIRE_TOOLS`; declaring one is what turns a missing
 * tool from a skip into a failure, so a runner cannot lose a tool quietly.
 */
describe("gating a suite on an external tool", () => {
	/** The normal case: the tool is there and the gate must not interfere. */
	it("runs the suite with no message when the tool is on PATH", () => {
		const decision = resolveToolGate({
			tool: "julia",
			name: "eval Julia prelude helpers",
			present: true,
			declared: false,
		});
		expect(decision.action).toBe("run");
		expect(decision.message).toBe("");
	});

	/** A declaration changes nothing when the tool is actually there. */
	it("runs the suite when the tool is both declared and on PATH", () => {
		const decision = resolveToolGate({
			tool: "julia",
			name: "eval Julia prelude helpers",
			present: true,
			declared: true,
		});
		expect(decision.action).toBe("run");
		expect(decision.message).toBe("");
	});

	/**
	 * The developer-machine case. Skipping is right, silence is not: the message
	 * has to name the tool, say the suite did not run, and warn that an
	 * environment which declares the tool does run it, or the reader still comes
	 * away believing the file passed.
	 */
	it("skips loudly when the tool is absent and undeclared, naming the tool and the gap it leaves", () => {
		const decision = resolveToolGate({
			tool: "julia",
			name: "eval Julia prelude helpers",
			present: false,
			declared: false,
		});
		expect(decision.action).toBe("skip");
		expect(decision.message).toBe(
			'[skip] "eval Julia prelude helpers" needs julia, which is not on PATH, so it did NOT run here. ' +
				"An environment that declares julia does run it, so a failure you cannot see locally is possible. " +
				"Install: https://julialang.org/install/ (or `juliaup add release`)",
		);
	});

	/**
	 * A tool with no install hint still produces a complete, useful message. The
	 * hint is an extra, not the thing that makes the skip visible.
	 */
	it("still skips loudly for a tool it has no install hint for", () => {
		const decision = resolveToolGate({ tool: "cobol", name: "legacy suite", present: false, declared: false });
		expect(decision.action).toBe("skip");
		expect(decision.message).toBe(
			'[skip] "legacy suite" needs cobol, which is not on PATH, so it did NOT run here. ' +
				"An environment that declares cobol does run it, so a failure you cannot see locally is possible.",
		);
		// No dangling "Install:" with nothing after it.
		expect(decision.message).not.toContain("Install:");
	});

	/**
	 * The contract that matters most. An environment that declared the tool and
	 * then does not have it is a provisioning bug, and skipping there is how an
	 * entire suite gets switched off for months without one red build.
	 */
	it("fails rather than skips when a declared tool is missing", () => {
		const decision = resolveToolGate({
			tool: "julia",
			name: "eval Julia prelude helpers",
			present: false,
			declared: true,
		});
		expect(decision.action).toBe("fail");
		expect(decision.message).toBe(
			'julia is not on PATH, but this environment declares it via VEYYON_REQUIRE_TOOLS, so "eval Julia prelude helpers" ' +
				"cannot run and must not be skipped. Install julia where this suite runs, or stop declaring it.",
		);
	});

	/** The failure has to say what to fix, and the fix is the environment, not the test. */
	it("points the failure at the environment rather than at the suite", () => {
		const decision = resolveToolGate({ tool: "rg", name: "search integration", present: false, declared: true });
		expect(decision.message).toContain("VEYYON_REQUIRE_TOOLS");
		expect(decision.message).toContain("Install rg where this suite runs");
		// It says skipping is not the answer; it must not be MARKED as a skip.
		expect(decision.message).not.toStartWith("[skip]");
	});

	/**
	 * Declared-and-missing and undeclared-and-missing must not collapse into the
	 * same answer. They differ only by `declared`, so a regression that dropped
	 * that branch would leave every other assertion here passing.
	 */
	it("answers differently for the same missing tool depending on whether it was declared", () => {
		const local = resolveToolGate({ tool: "julia", name: "s", present: false, declared: false });
		const ci = resolveToolGate({ tool: "julia", name: "s", present: false, declared: true });
		expect(local.action).toBe("skip");
		expect(ci.action).toBe("fail");
		expect(local.message).not.toBe(ci.message);
	});
});
