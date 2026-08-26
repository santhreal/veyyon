import type { AssistantMessage, Message } from "@veyyon/ai";

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/** Removes API-level provider refusals from live provider replay while preserving other messages. */
export function filterProviderReplayMessages(messages: readonly Message[]): Message[] {
	if (!messages.some(m => m.role === "assistant" && isProviderRefusalMessage(m))) return messages as Message[];
	return messages.filter(m => m.role !== "assistant" || !isProviderRefusalMessage(m));
}
