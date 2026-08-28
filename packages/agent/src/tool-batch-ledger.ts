import { truncate } from "@veyyon/utils/format";

export type ToolBatchCallOutcome = "ok" | "failed" | "interrupted" | "dropped";

export interface ToolBatchCallEntry {
	toolCallId: string;
	toolName: string;
	outcome: ToolBatchCallOutcome;
	argumentsIncomplete?: boolean;
}

export type ToolBatchLedgerCause = "stream_error" | "aborted" | "interrupted";

export interface ToolBatchLedger {
	cause: ToolBatchLedgerCause;
	entries: ToolBatchCallEntry[];
	completed: number;
	interrupted: number;
	dropped: number;
	omitted: number;
}

export const TOOL_BATCH_LEDGER_MAX_ENTRIES = 24;
export const TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH = 48;

export function buildToolBatchLedger(
	cause: ToolBatchLedgerCause,
	calls: ReadonlyArray<ToolBatchCallEntry>,
): ToolBatchLedger {
	let completed = 0;
	let interrupted = 0;
	let dropped = 0;
	for (const call of calls) {
		if (call.outcome === "dropped") dropped++;
		else if (call.outcome === "interrupted") interrupted++;
		else completed++;
	}
	const entries = calls.slice(0, TOOL_BATCH_LEDGER_MAX_ENTRIES).map(call => ({
		toolCallId: truncate(call.toolCallId, TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH),
		toolName: truncate(call.toolName, TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH),
		outcome: call.outcome,
		...(call.argumentsIncomplete === true ? { argumentsIncomplete: true as const } : {}),
	}));
	return {
		cause,
		entries,
		completed,
		interrupted,
		dropped,
		omitted: calls.length - entries.length,
	};
}

const OUTCOME_LABEL: Record<ToolBatchCallOutcome, string> = {
	ok: "ran, ok",
	failed: "ran, failed",
	interrupted: "started, no result recorded",
	dropped: "never ran",
};

const CAUSE_LINE: Record<ToolBatchLedgerCause, string> = {
	stream_error:
		"Cause: the provider stream ended before the remaining calls were dispatched. That is a transport failure, not a tool failure.",
	aborted: "Cause: the turn was aborted before the remaining calls were dispatched.",
	interrupted: "Cause: the batch was interrupted before the remaining calls were dispatched.",
};

export const TOOL_BATCH_LEDGER_HEADLINE_PREFIX = "Partial completion ledger for this tool batch (";

export function renderToolBatchLedger(ledger: ToolBatchLedger): string {
	const total = ledger.completed + ledger.interrupted + ledger.dropped;
	const counts = [`${ledger.completed} ran`];
	if (ledger.interrupted > 0) counts.push(`${ledger.interrupted} interrupted`);
	counts.push(`${ledger.dropped} never ran`);
	const lines = [
		`${TOOL_BATCH_LEDGER_HEADLINE_PREFIX}${total} call${total === 1 ? "" : "s"}): ${counts.join(", ")}.`,
		CAUSE_LINE[ledger.cause],
	];
	for (const entry of ledger.entries) {
		const label =
			entry.argumentsIncomplete === true ? "never ran, arguments never finished" : OUTCOME_LABEL[entry.outcome];
		lines.push(`- ${label}: ${entry.toolCallId} (${entry.toolName})`);
	}
	if (ledger.omitted > 0) {
		lines.push(`- (+${ledger.omitted} more call${ledger.omitted === 1 ? "" : "s"} not listed)`);
	}
	if (ledger.completed > 0) {
		lines.push(
			'Results for the calls marked "ran" are already in this transcript, including the failed ones. Do not re-run them.',
		);
	}
	if (ledger.interrupted > 0) {
		lines.push(
			'The calls marked "started, no result recorded" may have applied partial side effects. Check state before retrying them.',
		);
	}
	if (ledger.dropped > 0) {
		lines.push('Only the calls marked "never ran" need retrying; they had no side effects.');
	}
	if (ledger.entries.some(entry => entry.argumentsIncomplete === true)) {
		lines.push(
			'The calls marked "arguments never finished" were cut off while their arguments were still being written, so no record of them is left in this transcript. Reconstruct their arguments rather than copying them back.',
		);
	}
	return lines.join("\n");
}
