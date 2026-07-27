/**
 * The shortest turn a tokens-per-second rate is computed for.
 *
 * Below this the rate is nonsense: a cached or instant response divides real output
 * tokens by a few milliseconds and reports thousands of tokens per second.
 *
 * Exported because two components publish this rate, the status line through
 * `calculateTokensPerSecond` below and the per-turn usage row, and each used to hold its
 * own copy. They did not even agree at the boundary: this file rejected a duration
 * `< MIN_DURATION_MS` while the usage row required `> MIN_DURATION_MS`, so a turn of
 * exactly 100ms got a rate in one place and not the other.
 */
export const MIN_RATE_DURATION_MS = 100;

/**
 * Tokens per second for one turn, or `null` when the turn is too short or too empty to
 * yield a meaningful rate.
 *
 * THE one owner of that arithmetic and of its guards. Both callers used to divide
 * inline, which is how the boundary disagreement above went unnoticed.
 */
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

type AssistantLikeMessage = {
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

function isAssistantMessage(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

function getLastAssistantMessage(messages: ReadonlyArray<MaybeAssistantMessage>): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) return null;

	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	return tokensPerSecond(assistant.usage.output, resolvedDurationMs);
}
