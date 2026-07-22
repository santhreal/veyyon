import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@veyyon/ai";

/**
 * Per-provider cap on the number of images allowed in one request, measured
 * against each provider's documented/observed vision limit. Unknown providers
 * fall back to {@link DEFAULT_PROVIDER_IMAGE_BUDGET}.
 */
const PROVIDER_IMAGE_BUDGETS: Record<string, number> = {
	anthropic: 90,
	"amazon-bedrock": 90,
	openai: 200,
	"openai-codex": 200,
	google: 200,
	"google-vertex": 200,
	"google-gemini-cli": 200,
	openrouter: 90,
	umans: 10,
};

/** Safe floor for unknown providers (strictest mainstream measured: Groq ~5). */
const DEFAULT_PROVIDER_IMAGE_BUDGET = 5;

/** Per-request image budget for `provider`; unknown providers get the floor. */
export function providerImageBudget(provider: string | undefined): number {
	return (provider !== undefined ? PROVIDER_IMAGE_BUDGETS[provider] : undefined) ?? DEFAULT_PROVIDER_IMAGE_BUDGET;
}

const IMAGE_OMISSION_PLACEHOLDER: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

function countImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

/**
 * Clamp content parts, then substitute the omission placeholder when the clamp
 * would otherwise leave an empty content array. Providers (Anthropic / Bedrock
 * anthropic-messages and others) reject a message with empty content, so an
 * image-only message whose sole image is dropped must never ship as `[]`.
 * Returns undefined when nothing was dropped so callers keep the original.
 * Shared by every role clamper so the guard lives in exactly one place.
 */
function clampContentPreservingNonEmpty(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent)[] | undefined {
	const clamped = clampContent(content, state);
	if (!clamped) return undefined;
	return clamped.length > 0 ? clamped : [IMAGE_OMISSION_PLACEHOLDER];
}

function clampUserMessage(message: UserMessage, state: { remainingDrops: number }): UserMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContentPreservingNonEmpty(message.content, state);
	return content ? { ...message, content } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: { remainingDrops: number }): DeveloperMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContentPreservingNonEmpty(message.content, state);
	return content ? { ...message, content } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContentPreservingNonEmpty(message.content, state);
	if (!content) return message;
	return { ...message, content };
}

/** Drops oldest transient image blocks so outgoing vision requests fit the active provider's image cap. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const totalImages = countImages(context);
	if (totalImages <= limit) return context;

	const state = { remainingDrops: totalImages - limit };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}
