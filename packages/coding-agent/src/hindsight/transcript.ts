/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * The Hindsight retain/recall API only takes flat `{role, content}` records,
 * so we drop tool calls, tool results, bash execution wrappers, custom
 * messages, and anything else that isn't a primary conversation turn. Each
 * surviving message's `TextContent` parts are joined with newlines.
 */

import { type AssistantMessage, assistantTextBlocks } from "@veyyon/ai";
import { contentText } from "@veyyon/utils";
import type { SessionEntry } from "../session/session-entries";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. — they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function extractMessages(sessionManager: ReadonlySessionManagerLike): HindsightMessage[] {
	const messages: HindsightMessage[] = [];

	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text =
			role === "user"
				? contentText((msg as { content: unknown }).content)
				: assistantTextBlocks(msg as AssistantMessage)
						.filter(Boolean)
						.join("\n");
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role, content: text });
	}

	return messages;
}
