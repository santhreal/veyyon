/**
 * Pure polling decision for the AgentDrawer's incremental transcript reads.
 *
 * Mirrors the TUI guest's contract (agent-transcript-viewer): a `null` reply
 * (timeout / session end) is transient and retryable from the same cursor; a
 * frame-level host `error` is terminal — the host replies with an unchanged
 * cursor, so retrying would loop hot without ever surfacing the failure.
 */

import { type JsonlSkip, parseJsonlIncremental } from "@veyyon/utils/jsonl-incremental";
import type { SessionEntry } from "@veyyon/wire";
import type { TranscriptResult } from "./client";

/** What one transcript poll round decided (pure; the drawer's effect executes it). */
export type TranscriptPollDecision =
	/** Transient failure (timeout / not yet available): keep the cursor, poll again. */
	| { action: "retry" }
	/** Terminal host error: stop polling and surface the message (prior rows stay). */
	| { action: "stop"; message: string }
	/** Rows read: advance the cursor and append the parsed entries. */
	| {
			action: "advance";
			newSize: number;
			carry: string;
			fresh: readonly SessionEntry[];
			/**
			 * Transcript lines that were not valid JSON and were therefore dropped.
			 *
			 * Carried out of the decision instead of being swallowed by the parser: a
			 * dropped row leaves a hole in the rendered transcript that looks exactly
			 * like the agent never having said anything there. The drawer shows this
			 * so a corrupt transcript is visibly corrupt.
			 */
			skipped: readonly JsonlSkip[];
	  };

/** Maps one {@link TranscriptResult} reply to a polling decision. */
export function decideTranscriptPoll(reply: TranscriptResult | null, carry: string): TranscriptPollDecision {
	if (reply === null) return { action: "retry" };
	if (reply.kind === "error") return { action: "stop", message: reply.message };
	const skipped: JsonlSkip[] = [];
	const parsed = parseJsonlIncremental(reply.text, carry, { onSkip: skip => skipped.push(skip) });
	const fresh: SessionEntry[] = [];
	for (const item of parsed.items) {
		if (typeof item !== "object" || item === null) continue;
		if ("type" in item && item.type === "session") continue;
		fresh.push(item as SessionEntry);
	}
	return { action: "advance", newSize: reply.newSize, carry: parsed.carry, fresh, skipped };
}
