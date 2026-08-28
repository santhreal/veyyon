import { type JsonlSkip, parseJsonlIncremental } from "@veyyon/utils/jsonl-incremental";
import type { WireSessionEntry } from "@veyyon/wire";
import type { TranscriptResult } from "./client";

export type TranscriptPollDecision =
	| { action: "retry" }
	| { action: "stop"; message: string }
	| {
			action: "advance";
			newSize: number;
			carry: string;
			fresh: readonly WireSessionEntry[];
			skipped: readonly JsonlSkip[];
	  };

export function decideTranscriptPoll(reply: TranscriptResult | null, carry: string): TranscriptPollDecision {
	if (reply === null) return { action: "retry" };
	if (reply.kind === "error") return { action: "stop", message: reply.message };
	const skipped: JsonlSkip[] = [];
	const parsed = parseJsonlIncremental(reply.text, carry, { onSkip: skip => skipped.push(skip) });
	const fresh: WireSessionEntry[] = [];
	for (const item of parsed.items) {
		if (typeof item !== "object" || item === null) continue;
		if ("type" in item && item.type === "session") continue;
		fresh.push(item as WireSessionEntry);
	}
	return { action: "advance", newSize: reply.newSize, carry: parsed.carry, fresh, skipped };
}
