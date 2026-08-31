/**
 * Partial-completion ledger for a batch of tool calls that was cut short.
 *
 * When a turn's tool calls stop part-way (a provider stream reset such as
 * `NGHTTP2_INTERNAL_ERROR`, a user abort, or a mid-batch steering interrupt),
 * every unexecuted call gets its own placeholder result. On its own that tells
 * the model nothing about the batch: it cannot see which siblings produced real
 * results and which never ran, so the cheapest safe move looks like re-running
 * discovery from scratch. That rediscovery, not the failed turn, is the
 * expensive part of the failure.
 *
 * The ledger is one bounded summary emitted once per cut-short batch. It lists
 * tool-call ids and a one-word outcome, never tool output, so it can never
 * become a second echo of the payload it is describing.
 *
 * The outcome vocabulary is the point of the whole structure: "the tool ran and
 * failed" and "the tool never ran" call for opposite responses from the model,
 * and a transport reset produces only the second kind.
 */

// The owner, not the `@veyyon/utils` barrel. `truncate` cuts by CODE POINT; the private `clip`
// this replaced sliced by UTF-16 code unit, so a ledger field ending mid-surrogate-pair emitted a
// lone surrogate that `JSON.stringify` writes to the wire as a bare `\udXXX` escape.
import { truncate } from "@veyyon/utils/format";

/**
 * What happened to one call in a cut-short batch.
 *
 * - `ok` / `failed`: the tool executed. Its result is already in the
 *   transcript, so re-running it repeats work and any side effects.
 * - `interrupted`: execution began and no result was recorded. Side effects may
 *   be partially applied, so state must be checked before a retry.
 * - `dropped`: the call was never dispatched. Nothing happened, so it is safe
 *   to retry verbatim.
 */
export type ToolBatchCallOutcome = "ok" | "failed" | "interrupted" | "dropped";

export interface ToolBatchCallEntry {
	toolCallId: string;
	toolName: string;
	outcome: ToolBatchCallOutcome;
	/**
	 * The call's arguments were still streaming when the batch was cut short, so
	 * its `toolCall` block was removed from the assistant message and there is
	 * nothing in the transcript to re-read. Only ever set alongside `dropped`:
	 * an argument stream that never closed was never dispatched. The model has
	 * to reconstruct the arguments rather than copy them back.
	 */
	argumentsIncomplete?: boolean;
}

/** Why the batch stopped, which decides the cause line and the retry advice. */
export type ToolBatchLedgerCause = "stream_error" | "aborted" | "interrupted";

export interface ToolBatchLedger {
	cause: ToolBatchLedgerCause;
	entries: ToolBatchCallEntry[];
	/** Calls that executed to completion, successfully or not. */
	completed: number;
	/** Calls whose execution began and was cut off. */
	interrupted: number;
	/** Calls that were never dispatched. */
	dropped: number;
	/** Entries beyond {@link TOOL_BATCH_LEDGER_MAX_ENTRIES}, counted but not listed. */
	omitted: number;
}

/** Listed entries. Beyond this the ledger reports a count instead of more lines. */
export const TOOL_BATCH_LEDGER_MAX_ENTRIES = 24;
/** Per-field character budget, so one hostile id or tool name cannot unbound a line. */
export const TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH = 48;

/**
 * Build a ledger from the batch's per-call outcomes. Order is preserved: the
 * model reads the batch in the order it emitted the calls.
 */
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

/**
 * The opening of the ledger's headline, exported so a reader can recognize a
 * rendered ledger it has no ledger data for.
 *
 * A cut-short batch that left no placeholder result (every call exec-resolved or
 * its arguments never finished) carries the ledger as a synthetic user message
 * instead, which stores no `batchLedger` to re-render from. Recognizing it by
 * this prefix is the only handle there is, and the prefix belongs here rather
 * than at the reader, so a reworded headline breaks the render and the
 * recognition together instead of silently retiring the recognition.
 */
export const TOOL_BATCH_LEDGER_HEADLINE_PREFIX = "Partial completion ledger for this tool batch (";

/**
 * Render the ledger as the bounded text block attached to one placeholder
 * result per batch. Ids and outcomes only: no arguments, no tool output.
 */
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
