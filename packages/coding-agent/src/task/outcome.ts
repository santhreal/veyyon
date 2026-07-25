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

/**
 * Whether any child in a batch failed, which is what decides `isError` on a
 * merged multi-spawn result.
 *
 * A batch is reported as failed if ANY child failed. The alternative, reporting
 * success when at least one child succeeded, hides the failures inside a wall
 * of successful output, which is exactly where a parent stops looking.
 */
export function anySubagentFailed(results: readonly Pick<SingleResult, "aborted" | "exitCode" | "error">[]): boolean {
	return results.some(result => classifySubagentOutcome(result).isError);
}
