/** The shortest turn a tokens-per-second rate is computed for. Below this the rate is nonsense: a cached or instant response divides real output */
export const MIN_RATE_DURATION_MS = 100;

/** Tokens per second for one turn, or `null` when the turn is too short or too empty to yield a meaningful rate. */
export function tokensPerSecond(outputTokens: number, durationMs: number | null | undefined): number | null {
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
	if (durationMs === null || durationMs === undefined) return null;
	if (!Number.isFinite(durationMs) || durationMs < MIN_RATE_DURATION_MS) return null;

	const rate = (outputTokens * 1000) / durationMs;
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

type AssistantUsage = {
	output: number;
};

export type AssistantLikeMessage = {
	role: "assistant";
	timestamp: number;
	duration?: number;
	usage: AssistantUsage;
};

type MaybeAssistantMessage = {
	role?: string;
	timestamp?: number;
	duration?: number;
	usage?: {
		output?: number;
	};
};

/** Whether a message is an assistant turn this module can compute a rate from. STRICTER THAN THE ROLE. It also requires a numeric `timestamp` and a numeric */
function isRateableAssistantTurn(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

export function getLastRateableAssistantMessage(
	messages: ReadonlyArray<MaybeAssistantMessage>,
): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isRateableAssistantTurn(message)) {
			return message;
		}
	}
	return null;
}

export function tokensPerSecondForMessage(
	assistant: AssistantLikeMessage,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	return tokensPerSecond(assistant.usage.output, resolvedDurationMs);
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const assistant = getLastRateableAssistantMessage(messages);
	if (!assistant) return null;
	return tokensPerSecondForMessage(assistant, isStreaming, nowMs);
}
