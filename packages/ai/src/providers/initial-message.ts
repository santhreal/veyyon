import { emptyUsage } from "@veyyon/catalog/models";
import type { Api, AssistantMessage } from "../types";

/** Initial empty `AssistantMessage` that streaming providers accumulate into. */
export function createInitialResponsesAssistantMessage(api: Api, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
