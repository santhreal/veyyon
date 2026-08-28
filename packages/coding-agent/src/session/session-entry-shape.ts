/** The shape check every session record passes on its way in. A session file is JSONL that anybody can edit, and `JSON.parse` succeeding */
import { isRecord } from "@veyyon/utils/type-guards";

/** Why a record was rejected, phrased for the operator who has to fix the file. */
export type SessionEntryShapeProblem = string;

/** A record that satisfies the contract, or the reason it does not. */
export type SessionEntryShapeResult = { ok: true } | { ok: false; problem: SessionEntryShapeProblem };

const OK: SessionEntryShapeResult = { ok: true };

function bad(problem: SessionEntryShapeProblem): SessionEntryShapeResult {
	return { ok: false, problem };
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** The four token counters every usage reader sums without checking. */
const USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function checkAssistantMessage(message: Record<string, unknown>): SessionEntryShapeResult {
	if (!Array.isArray(message.content)) {
		return bad("an assistant message has no `content` array");
	}
	const usage = message.usage;
	if (!isRecord(usage)) {
		return bad("an assistant message has no `usage` record");
	}
	for (const counter of USAGE_COUNTERS) {
		if (typeof usage[counter] !== "number" || !Number.isFinite(usage[counter])) {
			return bad(`an assistant message has no finite \`usage.${counter}\``);
		}
	}
	return OK;
}

function checkMessageEntry(entry: Record<string, unknown>): SessionEntryShapeResult {
	const message = entry.message;
	if (!isRecord(message)) {
		return bad("a message entry has no `message` object");
	}
	if (!isNonEmptyString(message.role)) {
		return bad("a message entry has no `message.role`");
	}
	return message.role === "assistant" ? checkAssistantMessage(message) : OK;
}

/** Decide whether a decoded JSONL record may be treated as a `FileEntry`. Callers drop what this rejects and report the `problem` text alongside the */
export function checkSessionEntryShape(value: unknown): SessionEntryShapeResult {
	if (!isRecord(value)) return bad("a record that is not a JSON object");
	if (!isNonEmptyString(value.type)) return bad("a record with no `type`");

	// The fixed-width title slot is a physical first line, not a logical entry.
	if (value.type === "title") {
		return isNonEmptyString(value.title) ? OK : bad("a title slot with no `title`");
	}

	// `id`, `parentId` and `timestamp` are deliberately NOT required. Version-1 sessions were written without them and `migrateSessionEntries` fills them
	return value.type === "message" ? checkMessageEntry(value) : OK;
}
