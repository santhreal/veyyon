/**
 * WHY: the converted-message cache is keyed on the message object and validated
 * by comparing `content` BY REFERENCE, while a block region is applied by
 * writing `block.text` inside the existing array. The array reference does not
 * move, so a cache entry written before the shake stays valid by that test and
 * the provider is handed the text that was supposed to be gone.
 *
 * This is the failure that matters most for a reducer of last resort: the
 * estimate falls (that cache is digest-validated), maintenance reports it made
 * progress, and the request still carries the bytes — so the session is told it
 * recovered and then fails to send for the same reason as before.
 *
 * The sweep is over every role whose converter caches `content`, taken from the
 * cache's own union rather than a list, so a role that starts caching is
 * covered here the day it does.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { applyShakeRegion, convertMessageToLlm, type ShakeRegion } from "@veyyon/agent-core/compaction";

const BULK = "REMOVED_MIDDLE";

function entryFor(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message };
}

/** A message of `role` whose model-visible text is an array of blocks. */
function blockMessage(role: string): AgentMessage {
	const base = { role, content: [{ type: "text", text: `head ${BULK} tail` }], timestamp: 1 };
	if (role === "toolResult") {
		return { ...base, toolCallId: "call-1", toolName: "read", isError: false } as unknown as AgentMessage;
	}
	if (role === "custom" || role === "hookMessage") {
		return { ...base, customType: "note", display: true } as unknown as AgentMessage;
	}
	return base as unknown as AgentMessage;
}

function textOf(converted: unknown): string {
	if (converted === null || typeof converted !== "object") return "";
	const content = (converted as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block =>
			block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "",
		)
		.join("");
}

// Every role whose converter keeps a cache entry validated on `content`.
const CONTENT_CACHED_ROLES = ["user", "developer", "custom", "hookMessage", "toolResult"] as const;

describe("a truncated block reaches the provider", () => {
	for (const role of CONTENT_CACHED_ROLES) {
		test(`${role}: the converted message loses the middle the shake removed`, () => {
			const message = blockMessage(role);
			const entry = entryFor(message);

			// The conversion that populates the cache: a live session has already sent
			// this message at least once before maintenance runs on it.
			const before = convertMessageToLlm(message);
			expect(textOf(before)).toContain(BULK);

			const text = `head ${BULK} tail`;
			const region: ShakeRegion = {
				kind: "block",
				entry,
				address: { field: "content", blockIndex: 0 },
				start: text.indexOf(BULK),
				end: text.indexOf(BULK) + BULK.length,
				tokens: 4,
				originalText: BULK,
				label: "text",
				truncation: true,
			};
			applyShakeRegion(region, "[truncated]");

			const after = convertMessageToLlm(message);
			expect(textOf(after)).toContain("[truncated]");
			expect(textOf(after)).not.toContain(BULK);
		});
	}
});
