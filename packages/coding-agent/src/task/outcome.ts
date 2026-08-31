import type { SingleResult } from "./types";

/**
 * The one place a settled subagent run is classified as succeeded or failed.
 *
 * WHY THIS EXISTS. "Did this child fail?" was spelled out inline in six places
 * across `index.ts` and `render.ts`, and they did not agree: some treated an
 * abort as its own status, some folded it into failure, some noticed a
 * non-empty `error` at exit 0 (a merge failure) and some did not. A parent
 * deciding what to do next, a TUI picking an icon, and a progress row writing a
 * status were each answering the same question with different code.
 *
 * The more serious consequence was that none of them set `isError` on the tool
 * result. `agent-loop` reads that field to surface a tool call as a failure on
 * the wire, and `render.ts` reads it to colour the row, so a subagent that
 * crashed reached the parent model as a STRUCTURALLY SUCCESSFUL tool result
 * whose text happened to contain the word "failed". A model scanning results
 * for errors would find none, and a crashed child would read as a child that
 * had nothing to report.
 */

/** What actually happened to a settled subagent run. */
export type SubagentOutcomeKind =
	/** Ran to completion and produced its result. */
	| "completed"
	/** Produced a result, but delivering it (the isolation merge) failed. */
	| "merge-failed"
	/** Exited non-zero: crashed, was killed, or reported a failure itself. */
	| "failed"
	/** Did not finish: cancelled by the parent, out of budget, or self-aborted. */
	| "aborted";

export interface SubagentOutcome {
	kind: SubagentOutcomeKind;
	/**
	 * Whether the parent's tool result must carry `isError`.
	 *
	 * True for everything except a clean completion, including an abort. An
	 * abort means the parent did not get the work it asked for, and reporting
	 * that as a successful tool call is the same silent success this module
	 * exists to prevent. The parent can still read the abort reason and decide
	 * the cancellation was its own doing.
	 */
	isError: boolean;
	/** Short status word for summaries shown to the model. */
	label: string;
}

/**
 * Classify a settled run.
 *
 * Precedence is deliberate and is the part the old inline copies disagreed on:
 * an abort outranks the exit code, because a run cancelled mid-flight may carry
 * any exit code and "aborted" is the more actionable fact; a non-zero exit
 * outranks a merge failure, because a child that never produced a result cannot
 * have failed to merge one.
 */
export function classifySubagentOutcome(result: Pick<SingleResult, "aborted" | "exitCode" | "error">): SubagentOutcome {
	if (result.aborted) return { kind: "aborted", isError: true, label: "cancelled" };
	if (result.exitCode !== 0) {
		return { kind: "failed", isError: true, label: `failed (exit ${result.exitCode})` };
	}
	// Exit 0 with an error set is the isolation path: the child did its work and
	// the merge back could not be applied. The work is not lost (the branch or
	// patch is still there), but the parent did not receive it, so it is a
	// failure of the operation the parent requested.
	if (result.error) return { kind: "merge-failed", isError: true, label: "merge failed" };
	return { kind: "completed", isError: false, label: "completed" };
}

/** What a batch of subagent runs amounts to, counted by outcome. */
export interface SubagentBatchSummary {
	/** Ran to completion and delivered. */
	completed: number;
	/** Did not finish: cancelled by the parent, out of budget, or self-aborted. */
	cancelled: number;
	/** Exited non-zero, or produced work whose merge back could not be applied. */
	failed: number;
	/**
	 * Whether the merged tool result carries `isError`.
	 *
	 * FAILURES ONLY. Cancellation is not a failure claim: a five-agent fan-out
	 * that the operator stopped after three finished used to arrive at the parent
	 * model shaped exactly like one where two agents crashed, because both went
	 * through a single "did any child fail" predicate. The parent would then
	 * re-run work the operator had just stopped, and the three transcripts it did
	 * get were buried under a claim that something had gone wrong.
	 *
	 * This does NOT contradict {@link SubagentOutcome.isError}, which is true for
	 * a single aborted run. One run that was cancelled delivered nothing, so the
	 * call it belongs to failed. A batch is a different question: the completed
	 * children's work is real and is being returned, and the stop was the
	 * parent's own instruction. What the batch owes the reader is the truth about
	 * which children finished, which is {@link describeSubagentBatch}, not a
	 * failure flag standing in for it.
	 */
	isError: boolean;
}

/**
 * Count a batch of settled runs by outcome.
 *
 * The ONE owner of "what does this batch amount to", replacing a predicate that
 * answered only "did anything go wrong" and so could not tell a cancelled
 * fan-out from a failed one. Both merged multi-spawn results read it, so the
 * blocking-only path and the mixed async/sync path cannot drift apart.
 */
export function summarizeSubagentBatch(
	results: readonly Pick<SingleResult, "aborted" | "exitCode" | "error">[],
): SubagentBatchSummary {
	let completed = 0;
	let cancelled = 0;
	let failed = 0;
	for (const result of results) {
		const kind = classifySubagentOutcome(result).kind;
		if (kind === "aborted") cancelled++;
		else if (kind === "completed") completed++;
		else failed++;
	}
	return { completed, cancelled, failed, isError: failed > 0 };
}

/**
 * One line naming what became of a batch, or `undefined` when every child
 * completed and there is nothing to explain.
 *
 * Returned rather than pushed, so the caller decides where it goes. It leads the
 * merged content because a reader who scrolls a wall of subagent transcripts
 * needs to know up front that some of them are missing and why.
 */
export function describeSubagentBatch(summary: SubagentBatchSummary): string | undefined {
	if (summary.cancelled === 0 && summary.failed === 0) return undefined;
	const total = summary.completed + summary.cancelled + summary.failed;
	const parts = [`${summary.completed} of ${total} agents completed`];
	if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	return `${parts.join(", ")}.`;
}
