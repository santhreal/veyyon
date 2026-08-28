import type { SingleResult } from "./types";

/** The one place a settled subagent run is classified as succeeded or failed. across `index.ts` and `render.ts`, and they did not agree: some treated an */

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
	/** Whether the parent's tool result must carry `isError`. True for everything except a clean completion, including an abort. An */
	isError: boolean;
	/** Short status word for summaries shown to the model. */
	label: string;
}

/** Classify a settled run. Precedence is deliberate and is the part the old inline copies disagreed on: */
export function classifySubagentOutcome(result: Pick<SingleResult, "aborted" | "exitCode" | "error">): SubagentOutcome {
	if (result.aborted) return { kind: "aborted", isError: true, label: "cancelled" };
	if (result.exitCode !== 0) {
		return { kind: "failed", isError: true, label: `failed (exit ${result.exitCode})` };
	}
	// Exit 0 with an error set is the isolation path: the child did its work and the merge back could not be applied. The work is not lost (the branch or
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
	/** Whether the merged tool result carries `isError`. FAILURES ONLY. Cancellation is not a failure claim: a five-agent fan-out */
	isError: boolean;
}

/** Count a batch of settled runs by outcome. The ONE owner of "what does this batch amount to", replacing a predicate that */
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

/** One line naming what became of a batch, or `undefined` when every child completed and there is nothing to explain. */
export function describeSubagentBatch(summary: SubagentBatchSummary): string | undefined {
	if (summary.cancelled === 0 && summary.failed === 0) return undefined;
	const total = summary.completed + summary.cancelled + summary.failed;
	const parts = [`${summary.completed} of ${total} agents completed`];
	if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	return `${parts.join(", ")}.`;
}
