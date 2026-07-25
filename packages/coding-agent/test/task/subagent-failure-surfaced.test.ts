import { describe, expect, it } from "bun:test";
import { resolveSubagentErrorText } from "@veyyon/coding-agent/task/executor";
import { anySubagentFailed, classifySubagentOutcome } from "@veyyon/coding-agent/task/outcome";
import type { SingleResult } from "@veyyon/coding-agent/task/types";

/**
 * A subagent that fails must reach the parent AS A FAILURE, on every channel.
 *
 * WHY THIS SUITE EXISTS (SUB-1). A parent delegating work reads two things: the
 * `error` text, to learn what went wrong, and the tool result's `isError` flag,
 * which `agent-loop` turns into a tool error on the wire and which the TUI reads
 * to colour the row. Both were broken in the same direction, and the direction
 * is the dangerous one: they under-reported.
 *
 * `error` was set only when a non-zero exit ALSO had stderr text. A crashed
 * child (out-of-memory kill, native crash) has a non-zero exit, no stderr, and
 * no output, so it produced an empty error, which is the exact shape of a child
 * that ran fine and had nothing to say.
 *
 * `isError` was never set by the task tool at all. Every subagent failure,
 * including a crash, arrived at the parent as a structurally SUCCESSFUL tool
 * result whose text happened to contain the word "failed". A model scanning
 * results for errors would find none.
 *
 * Both halves are asserted here, and the success cases are asserted just as
 * hard: a fix that marked everything an error would satisfy every failure test
 * while making the flag meaningless.
 */

function makeResult(overrides: Partial<SingleResult>): Pick<SingleResult, "aborted" | "exitCode" | "error"> {
	return { aborted: false, error: undefined, exitCode: 0, ...overrides };
}

describe("classifying a settled subagent run", () => {
	/**
	 * The clean case, asserted first because it is what every failure case must
	 * be distinguishable FROM. `isError` false here is what makes it false
	 * everywhere else meaningful.
	 */
	it("treats exit 0 with no error as completed and not an error", () => {
		const outcome = classifySubagentOutcome(makeResult({ exitCode: 0 }));

		expect(outcome.kind).toBe("completed");
		expect(outcome.isError).toBe(false);
		expect(outcome.label).toBe("completed");
	});

	/**
	 * The case the row is about. A non-zero exit is a failure regardless of
	 * whether anything explained it, and the label carries the exact code so the
	 * parent can tell a crash (137) from a self-reported failure (1).
	 */
	it("treats any non-zero exit as a failure and names the code", () => {
		const outcome = classifySubagentOutcome(makeResult({ exitCode: 137 }));

		expect(outcome.kind).toBe("failed");
		expect(outcome.isError).toBe(true);
		expect(outcome.label).toBe("failed (exit 137)");
	});

	/**
	 * Exit 0 with an error set is the isolation path: the child did the work and
	 * the merge back could not be applied. The work still exists on its branch,
	 * but the parent did not receive it, so the operation the parent asked for
	 * failed and must be reported as such rather than as a warning it can skim.
	 */
	it("treats exit 0 with an error as a merge failure", () => {
		const outcome = classifySubagentOutcome(makeResult({ error: "merge conflict in src/a.ts" }));

		expect(outcome.kind).toBe("merge-failed");
		expect(outcome.isError).toBe(true);
		expect(outcome.label).toBe("merge failed");
	});

	/**
	 * An abort is not a success. The parent did not get the work it asked for,
	 * and a cancelled child reported as a successful tool call is the same
	 * silent success this whole module exists to prevent.
	 */
	it("treats an abort as an error even at exit 0", () => {
		const outcome = classifySubagentOutcome(makeResult({ aborted: true, exitCode: 0 }));

		expect(outcome.kind).toBe("aborted");
		expect(outcome.isError).toBe(true);
		expect(outcome.label).toBe("cancelled");
	});

	/**
	 * Precedence, which is the part the six inline copies disagreed on. A run
	 * cancelled mid-flight can carry any exit code and any error text; "aborted"
	 * is the more actionable fact, so it wins over both.
	 */
	it("reports an abort even when the exit code and error are also set", () => {
		const outcome = classifySubagentOutcome(makeResult({ aborted: true, error: "boom", exitCode: 1 }));

		expect(outcome.kind).toBe("aborted");
	});

	/**
	 * And a non-zero exit wins over a merge failure: a child that never produced
	 * a result cannot have failed to merge one, so labelling it "merge failed"
	 * would send the parent looking for a branch that does not exist.
	 */
	it("reports a non-zero exit rather than a merge failure when both look set", () => {
		const outcome = classifySubagentOutcome(makeResult({ error: "merge conflict", exitCode: 1 }));

		expect(outcome.kind).toBe("failed");
	});
});

describe("aggregating a batch of children", () => {
	/**
	 * A batch is a failure if ANY child failed. Reporting success because most
	 * of them worked buries the failures inside a wall of successful output,
	 * which is exactly where a parent stops reading.
	 */
	it("fails the batch when one child of many failed", () => {
		const results = [makeResult({}), makeResult({}), makeResult({ exitCode: 1 })];

		expect(anySubagentFailed(results)).toBe(true);
	});

	/** A single aborted child is enough, for the same reason. */
	it("fails the batch when one child was cancelled", () => {
		expect(anySubagentFailed([makeResult({}), makeResult({ aborted: true })])).toBe(true);
	});

	/**
	 * The negative half. An all-clean batch must not be an error, or the flag
	 * carries no information and a parent learns to ignore it.
	 */
	it("does not fail a batch where every child completed", () => {
		expect(anySubagentFailed([makeResult({}), makeResult({}), makeResult({})])).toBe(false);
	});

	/**
	 * An empty batch is not a failure. It happens when every spawn was cancelled
	 * before start, which is reported through its own path; inventing an error
	 * here would double-report it.
	 */
	it("does not fail an empty batch", () => {
		expect(anySubagentFailed([])).toBe(false);
	});
});

describe("the error text a failed run carries", () => {
	/**
	 * When the child said something, that is the message. Passing stderr through
	 * unchanged matters because it is the only place a real diagnosis appears,
	 * and rewording or prefixing it would bury the part the parent needs.
	 */
	it("uses the child's own stderr when it reported one", () => {
		expect(resolveSubagentErrorText(1, "TypeError: cannot read property 'x' of undefined", "", false)).toBe(
			"TypeError: cannot read property 'x' of undefined",
		);
	});

	/** Surrounding whitespace is not a message; it is trimmed before the check. */
	it("treats whitespace-only stderr as no message at all", () => {
		const text = resolveSubagentErrorText(1, "   \n\t ", "", false);

		expect(text).toContain("reported no error");
	});

	/**
	 * THE CASE THE ROW IS ABOUT. A crash leaves exit code, no stderr, no output.
	 * The old code returned undefined here, so the parent's error channel was
	 * empty precisely when the failure was most severe.
	 *
	 * The message must carry three things: the exit code, the fact that nothing
	 * was produced, and what that combination usually means. The last part is
	 * what stops the parent retrying the same prompt against the same limit.
	 */
	it("synthesizes a message when a crashed child said nothing at all", () => {
		const text = resolveSubagentErrorText(137, "", "", false);

		expect(text).toBeDefined();
		expect(text).toContain("137");
		expect(text).toContain("produced no output");
		expect(text).toContain("out of memory");
	});

	/**
	 * A child that produced output but no stderr still gets a message, and it
	 * must NOT claim there was no output, because the parent can go read it.
	 */
	it("does not claim there was no output when the child produced some", () => {
		const text = resolveSubagentErrorText(1, "", "partial work here", false);

		expect(text).toBeDefined();
		expect(text).not.toContain("produced no output");
		expect(text).toContain("1");
	});

	/**
	 * The negative half, and the one that keeps the field honest. A successful
	 * run carries no error text no matter what is in its stderr, because tools
	 * routinely write progress and warnings there and promoting those to an
	 * error would make every successful run look failed.
	 */
	it("reports no error for a successful run even with stderr output", () => {
		expect(resolveSubagentErrorText(0, "warning: deprecated flag", "the result", false)).toBeUndefined();
	});

	/**
	 * Every non-zero exit code produces a message. Checked across the range
	 * rather than at one value, because a condition that happened to work for 1
	 * and not for a signal-derived code would leave crashes silent again.
	 */
	it.each([1, 2, 127, 130, 137, 139, 143, 255])("always produces a message for exit %i", code => {
		const text = resolveSubagentErrorText(code, "", "", false);

		expect(text).toBeDefined();
		expect(text).toContain(String(code));
	});
	/**
	 * An ABORTED run gets no synthesized message. Its explanation lives on
	 * `abortReason` (a cancellation, a budget stop, a runtime limit), and `error`
	 * is deliberately empty so callers read the real reason rather than a vaguer
	 * second copy. Guessing "it most likely crashed or ran out of memory" for a
	 * run the parent itself cancelled would be actively wrong, and the eval
	 * bridge already depends on this emptiness to fall through to the reason.
	 */
	it("stays silent for an aborted run so the abort reason is what speaks", () => {
		expect(resolveSubagentErrorText(1, "", "", true)).toBeUndefined();
	});

	/**
	 * But an aborted run that DID report something on stderr still surfaces it.
	 * The rule is "do not invent a reason", not "discard the one it gave".
	 */
	it("still passes through real stderr on an aborted run", () => {
		expect(resolveSubagentErrorText(1, "connection reset", "", true)).toBe("connection reset");
	});
});
