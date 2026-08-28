/** Pull plain-text user/assistant messages out of a session manager. The Hindsight retain/recall API only takes flat `{role, content}` records, */

import type { AssistantMessage } from "@veyyon/ai";
// The block extractor from the module that defines it (1 module) rather than the barrel (346).
import { assistantTextBlocks } from "@veyyon/ai/utils/message-text";
import { contentText } from "@veyyon/utils/content-text";
import type { SessionEntry } from "../session/session-entries";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

/** Walk session entries top-to-bottom, returning a flat user/assistant list. Implementation choices: */
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
