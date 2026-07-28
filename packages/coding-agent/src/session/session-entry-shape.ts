/**
 * The shape check every session record passes on its way in.
 *
 * A session file is JSONL that anybody can edit, and `JSON.parse` succeeding
 * says nothing about whether the object has the fields the readers dereference.
 * A single assistant record missing `usage` used to take the whole transcript
 * down inside the viewer's constructor, because the type declares `usage` as
 * required and every reader believed it. Decoding is not validating: this module
 * is where a decoded record earns the `FileEntry` type it is about to be given.
 *
 * The check stays deliberately narrow. It asserts exactly the fields a reader
 * dereferences without guarding, and nothing else, so an older file still loads:
 * version-1 sessions carry no `id` or `parentId` at all, and a check that asked
 * for them would discard every record in the file it was meant to protect.
 *
 * Anything it rejects is DROPPED and reported, never repaired: inventing `0`
 * tokens for a turn would put a wrong number on screen and in every total
 * computed from it, which is worse than an absent row and impossible to notice
 * (Law 10).
 */
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

/**
 * Decide whether a decoded JSONL record may be treated as a `FileEntry`.
 *
 * Callers drop what this rejects and report the `problem` text alongside the
 * record's position in the file, the same way a line that would not decode at
 * all is reported.
 */
export function checkSessionEntryShape(value: unknown): SessionEntryShapeResult {
	if (!isRecord(value)) return bad("a record that is not a JSON object");
	if (!isNonEmptyString(value.type)) return bad("a record with no `type`");

	// The fixed-width title slot is a physical first line, not a logical entry.
	if (value.type === "title") {
		return isNonEmptyString(value.title) ? OK : bad("a title slot with no `title`");
	}

	// `id`, `parentId` and `timestamp` are deliberately NOT required. Version-1
	// sessions were written without them and `migrateSessionEntries` fills them
	// in AFTER the loader returns, so demanding them here would throw away every
	// pre-migration file in the name of protecting it. The header's own `id` is
	// already validated by `loadEntriesFromFile`, which is the one owner of what
	// makes a session file loadable at all.
	return value.type === "message" ? checkMessageEntry(value) : OK;
}
