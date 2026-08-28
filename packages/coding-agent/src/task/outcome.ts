import type { SingleResult } from "./types";

export type SubagentOutcomeKind = "completed" | "merge-failed" | "failed" | "aborted";

export interface SubagentOutcome {
	kind: SubagentOutcomeKind;
	isError: boolean;
	label: string;
}

export function classifySubagentOutcome(result: Pick<SingleResult, "aborted" | "exitCode" | "error">): SubagentOutcome {
	if (result.aborted) return { kind: "aborted", isError: true, label: "cancelled" };
	if (result.exitCode !== 0) {
		return { kind: "failed", isError: true, label: `failed (exit ${result.exitCode})` };
	}
	if (result.error) return { kind: "merge-failed", isError: true, label: "merge failed" };
	return { kind: "completed", isError: false, label: "completed" };
}

export interface SubagentBatchSummary {
	completed: number;
	cancelled: number;
	failed: number;
	isError: boolean;
}

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

export function describeSubagentBatch(summary: SubagentBatchSummary): string | undefined {
	if (summary.cancelled === 0 && summary.failed === 0) return undefined;
	const total = summary.completed + summary.cancelled + summary.failed;
	const parts = [`${summary.completed} of ${total} agents completed`];
	if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	return `${parts.join(", ")}.`;
}
