import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, TextContent } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { clampProviderContextImages, providerImageBudget } from "@veyyon/coding-agent/session/provider-image-budget";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

/**
 * providerImageBudget maps a provider id to its per-request image cap; it is the value that
 * clampProviderContextImages enforces. It had no direct test (only the clamp behavior was covered).
 * A wrong number here silently over- or under-drops images on every vision request for that
 * provider. These pin each known provider's documented cap, the shared caps (bedrock == anthropic
 * 90, the whole google/openai families at 200), and that any unknown or undefined provider falls to
 * the strict safe floor of 5 rather than an unbounded default.
 */
describe("providerImageBudget", () => {
	it("returns each known provider's documented per-request image cap", () => {
		expect(providerImageBudget("anthropic")).toBe(90);
		expect(providerImageBudget("amazon-bedrock")).toBe(90);
		expect(providerImageBudget("openrouter")).toBe(90);
		expect(providerImageBudget("openai")).toBe(200);
		expect(providerImageBudget("openai-codex")).toBe(200);
		expect(providerImageBudget("google")).toBe(200);
		expect(providerImageBudget("google-vertex")).toBe(200);
		expect(providerImageBudget("google-gemini-cli")).toBe(200);
		expect(providerImageBudget("umans")).toBe(10);
	});

	it("falls back to the strict floor of 5 for an unknown, empty, or undefined provider", () => {
		expect(providerImageBudget("groq")).toBe(5);
		expect(providerImageBudget("")).toBe(5);
		expect(providerImageBudget(undefined)).toBe(5);
	});
});

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 21}`));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "inspect_image",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("keeps an image-only user message meaningful when its sole image is dropped", () => {
		// Regression for FINDING-IMAGE-BUDGET-EMPTY-USER-CONTENT: clampToolResultMessage guarded the
		// all-dropped case with a placeholder but clampUserMessage did not, so an image-only user
		// message emptied by the budget clamp shipped as content:[] — which Anthropic/Bedrock reject,
		// producing a silent 400. The user path must now substitute the same omission placeholder.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "user",
				content: [image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("user");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
		// No message is ever left with an empty content array.
		for (const message of clamped.messages) {
			if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0);
		}
	});

	it("keeps an image-only developer message meaningful when its sole image is dropped", () => {
		// The developer path shares the same guard as the user path; an image-only developer
		// message emptied by clamping must also carry the placeholder, never content:[].
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "developer",
				content: [image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("developer");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("does not add a placeholder when the clamped user message still has text", () => {
		// The placeholder is only for the ALL-empty case: a mixed text+image message keeps just its
		// text after the image is dropped, with no spurious placeholder appended.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(clamped.messages[0]?.content).toEqual([text("text-0")]);
		expect(textData(clamped)).toEqual(Array.from({ length: 11 }, (_, index) => `text-${index}`));
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});
});
