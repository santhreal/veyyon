import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { TUI } from "@veyyon/tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";

export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
}

export function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	let result = "";
	for (let bi = 0; bi < message.content.length; bi++) {
		const block = message.content[bi]!;
		if (block.type === "text") result += block.text;
	}
	return result;
}
