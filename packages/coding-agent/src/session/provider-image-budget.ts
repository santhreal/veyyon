import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@veyyon/ai";
import { replaceLlmImagesWithText } from "./messages";

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

const DEFAULT_PROVIDER_IMAGE_BUDGET = 5;

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

const IMAGES_BLOCKED_TEXT = "Image reading is disabled.";

const NO_VISION_TEXT = "[image omitted: the model serving this request does not support image input]";

export interface ProviderImagePolicy {
	blockImages: boolean;
}

export function applyProviderImagePolicy(context: Context, model: Model, policy: ProviderImagePolicy): Context {
	if (policy.blockImages) {
		return withMessages(context, replaceLlmImagesWithText(context.messages, IMAGES_BLOCKED_TEXT));
	}
	if (!model.input.includes("image")) {
		return withMessages(context, replaceLlmImagesWithText(context.messages, NO_VISION_TEXT));
	}
	return clampProviderContextImages(context, model);
}

function withMessages(context: Context, messages: Context["messages"]): Context {
	return messages === context.messages ? context : { ...context, messages };
}
