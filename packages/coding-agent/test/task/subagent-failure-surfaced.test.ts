import { describe, expect, it } from "bun:test";
import { resolveSubagentErrorText } from "@veyyon/coding-agent/task/executor";
import {
	classifySubagentOutcome,
	describeSubagentBatch,
	summarizeSubagentBatch,
} from "@veyyon/coding-agent/task/outcome";
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
		const summary = summarizeSubagentBatch([makeResult({}), makeResult({}), makeResult({ exitCode: 1 })]);

		expect(summary.isError).toBe(true);
		expect(summary).toMatchObject({ completed: 2, cancelled: 0, failed: 1 });
	});

	/**
	 * THE CASE THIS SPLIT EXISTS FOR, and the one assertion here that reversed.
	 *
	 * A cancelled child used to fail the batch, through a predicate that asked
	 * only "did anything go wrong". So a five-agent fan-out the operator stopped
	 * after three finished arrived at the parent model shaped exactly like one
	 * where two agents crashed: the parent re-ran work that had just been
	 * cancelled on purpose, and the three transcripts it did get sat under a claim
	 * that something had failed.
	 *
	 * The single-run rule is unchanged, and the two do not contradict: one run
	 * that was cancelled delivered nothing, so its own call failed. A batch is a
	 * different question, because the completed children's work is real and is
	 * being returned, and the stop was the parent's own instruction. The counts
	 * below carry what the flag no longer has to.
	 */
	it("does not fail a batch that was only cancelled", () => {
		const summary = summarizeSubagentBatch([makeResult({}), makeResult({}), makeResult({ aborted: true })]);

		expect(summary.isError).toBe(false);
		expect(summary).toMatchObject({ completed: 2, cancelled: 1, failed: 0 });
	});

	/** Cancellation does not mask a real failure alongside it. */
	it("still fails a batch holding both a cancellation and a failure", () => {
		const summary = summarizeSubagentBatch([makeResult({ aborted: true }), makeResult({ exitCode: 2 })]);

		expect(summary.isError).toBe(true);
		expect(summary).toMatchObject({ completed: 0, cancelled: 1, failed: 1 });
	});

	/**
	 * A merge failure counts as failed, not as its own third thing: the child did
	 * the work and the parent did not receive it, so the operation it asked for
	 * did not happen.
	 */
	it("counts a merge failure as a failure", () => {
		const summary = summarizeSubagentBatch([makeResult({ error: "merge conflict" })]);

		expect(summary).toMatchObject({ completed: 0, cancelled: 0, failed: 1 });
		expect(summary.isError).toBe(true);
	});

	/**
	 * An abort outranks the exit code here exactly as it does for a single run, so
	 * a cancelled child that also exited non-zero is counted once, as cancelled.
	 * Counting it twice would report more children than the batch contains.
	 */
	it("counts a cancelled child that also exited non-zero as cancelled only", () => {
		const summary = summarizeSubagentBatch([makeResult({ aborted: true, exitCode: 1 })]);

		expect(summary).toMatchObject({ completed: 0, cancelled: 1, failed: 0 });
		expect(summary.isError).toBe(false);
	});

	/**
	 * The negative half. An all-clean batch must not be an error, or the flag
	 * carries no information and a parent learns to ignore it.
	 */
	it("does not fail a batch where every child completed", () => {
		const summary = summarizeSubagentBatch([makeResult({}), makeResult({}), makeResult({})]);

		expect(summary.isError).toBe(false);
		expect(summary).toMatchObject({ completed: 3, cancelled: 0, failed: 0 });
	});

	/**
	 * An empty batch is not a failure. It happens when every spawn was cancelled
	 * before start, which is counted through its own path; inventing an error
	 * here would double-report it.
	 */
	it("does not fail an empty batch", () => {
		expect(summarizeSubagentBatch([]).isError).toBe(false);
	});
});

describe("the line a batch shows the reader", () => {
	/**
	 * Silence when there is nothing to explain. A batch where everything worked
	 * would otherwise open with a sentence restating that, and a header that
	 * always appears is one a reader stops seeing.
	 */
	it("says nothing when every child completed", () => {
		expect(describeSubagentBatch(summarizeSubagentBatch([makeResult({}), makeResult({})]))).toBeUndefined();
	});

	/**
	 * The headline a cancelled fan-out needs: how many of the expected agents
	 * actually reported. Without the total, three transcripts read as the whole
	 * answer rather than as three fifths of one.
	 */
	it("names how many of the expected agents completed", () => {
		const summary = summarizeSubagentBatch([
			makeResult({}),
			makeResult({}),
			makeResult({}),
			makeResult({ aborted: true }),
			makeResult({ aborted: true }),
		]);

		expect(describeSubagentBatch(summary)).toBe("3 of 5 agents completed, 2 cancelled.");
	});

	/** Both kinds appear, and separately, because they call for different responses. */
	it("reports cancellations and failures as different things", () => {
		const summary = summarizeSubagentBatch([
			makeResult({}),
			makeResult({ aborted: true }),
			makeResult({ exitCode: 1 }),
		]);

		expect(describeSubagentBatch(summary)).toBe("1 of 3 agents completed, 1 cancelled, 1 failed.");
	});

	/** A failure with no cancellation does not mention cancelling. */
	it("omits the cancelled count when nothing was cancelled", () => {
		const summary = summarizeSubagentBatch([makeResult({}), makeResult({ exitCode: 1 })]);

		expect(describeSubagentBatch(summary)).toBe("1 of 2 agents completed, 1 failed.");
	});

	/**
	 * Spawns cancelled before they started have no result to classify, so callers
	 * add them to the count. The total has to move with them, or the line reports
	 * fewer agents than were asked for.
	 */
	it("counts spawns that never started once the caller adds them", () => {
		const summary = summarizeSubagentBatch([makeResult({}), makeResult({})]);
		summary.cancelled += 2;

		expect(describeSubagentBatch(summary)).toBe("2 of 4 agents completed, 2 cancelled.");
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
