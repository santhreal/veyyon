import type { AssistantMessage } from "@veyyon/ai";
import type { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

/** The slice of the interactive context this controller uses: 7 members of the 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency */
export type BtwControllerContext = Pick<
	InteractiveModeContext,
	"btwContainer" | "handleBtwBranch" | "session" | "sessionManager" | "showError" | "showStatus" | "ui"
>;

export interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	leafId: string | null;
}

export function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}
