import { describe, expect, it } from "bun:test";
import {
	buildCursorSystemPromptJsons,
	emptyGrepPatternRejection,
	extractAssistantMessageText,
	extractText,
	extractUserMessageText,
	hasImages,
} from "../src/providers/cursor-helpers";
import { createProviderErrorMessage } from "../src/providers/error-message";
import type { Message, Model } from "../src/types";

describe("extractUserMessageText", () => {
	it("returns trimmed string content", () => {
		const msg = { role: "user", content: "  hello world  " } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("hello world");
	});
	it("returns trimmed text from content array", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
		} as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("hello\nworld");
	});
	it("returns empty string for assistant role", () => {
		const msg = { role: "assistant", content: "hello" } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("");
	});
	it("returns empty string for toolResult role", () => {
		const msg = { role: "toolResult", content: [] } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("");
	});
	it("returns empty string for empty content", () => {
		const msg = { role: "user", content: "" } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("");
	});
	it("returns empty string for whitespace-only content", () => {
		const msg = { role: "user", content: "   " } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("");
	});
	it("filters out non-text blocks from content array", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "text", text: "hello" },
			],
		} as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("hello");
	});
	it("works with developer role", () => {
		const msg = { role: "developer", content: "  system prompt  " } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("system prompt");
	});
	it("returns empty string for empty content array", () => {
		const msg = { role: "user", content: [] } as unknown as Message;
		expect(extractUserMessageText(msg)).toBe("");
	});
});

describe("extractAssistantMessageText", () => {
	it("returns joined text from content array", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
		} as unknown as Message;
		expect(extractAssistantMessageText(msg)).toBe("hello\nworld");
	});
	it("returns empty string for non-assistant role", () => {
		const msg = { role: "user", content: "hello" } as unknown as Message;
		expect(extractAssistantMessageText(msg)).toBe("");
	});
	it("returns empty string for non-array content", () => {
		const msg = { role: "assistant", content: "hello" } as unknown as Message;
		expect(extractAssistantMessageText(msg)).toBe("");
	});
	it("filters out non-text blocks", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thoughts" },
				{ type: "text", text: "answer" },
			],
		} as unknown as Message;
		expect(extractAssistantMessageText(msg)).toBe("answer");
	});
	it("returns empty string for empty content array", () => {
		const msg = { role: "assistant", content: [] } as unknown as Message;
		expect(extractAssistantMessageText(msg)).toBe("");
	});
});

describe("buildCursorSystemPromptJsons", () => {
	it("returns array with one system message", () => {
		const result = buildCursorSystemPromptJsons();
		expect(result.length).toBe(1);
		const parsed = JSON.parse(result[0]) as { role: string; content: string };
		expect(parsed.role).toBe("system");
		expect(parsed.content).toBe("You are a helpful assistant.");
	});
	it("returns valid JSON strings", () => {
		const result = buildCursorSystemPromptJsons();
		for (const json of result) {
			expect(() => JSON.parse(json)).not.toThrow();
		}
	});
});

describe("hasImages", () => {
	it("returns true when content has image", () => {
		expect(hasImages([{ type: "image", data: "abc", mimeType: "image/png" }])).toBe(true);
	});
	it("returns false when content has only text", () => {
		expect(hasImages([{ type: "text", text: "hello" }])).toBe(false);
	});
	it("returns false for empty array", () => {
		expect(hasImages([])).toBe(false);
	});
	it("returns true for mixed content", () => {
		expect(
			hasImages([
				{ type: "text", text: "hello" },
				{ type: "image", data: "abc", mimeType: "image/png" },
			]),
		).toBe(true);
	});
});

describe("extractText", () => {
	it("returns joined text from content array", () => {
		expect(
			extractText([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		).toBe("hello\nworld");
	});
	it("filters out non-text items", () => {
		expect(
			extractText([
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "text", text: "hello" },
			]),
		).toBe("hello");
	});
	it("returns empty string for empty array", () => {
		expect(extractText([])).toBe("");
	});
	it("returns empty string for only images", () => {
		expect(extractText([{ type: "image", data: "abc", mimeType: "image/png" }])).toBe("");
	});
});

describe("emptyGrepPatternRejection", () => {
	it("returns null when pattern is non-empty", () => {
		expect(emptyGrepPatternRejection("foo", undefined)).toBeNull();
	});
	it("returns null when pattern is whitespace-only but non-empty after trim", () => {
		expect(emptyGrepPatternRejection("  foo  ", undefined)).toBeNull();
	});
	it("returns rejection message when pattern is undefined and no glob", () => {
		expect(emptyGrepPatternRejection(undefined, undefined)).toBe(
			"grep pattern is required (received an empty pattern).",
		);
	});
	it("returns rejection message when pattern is empty string and no glob", () => {
		expect(emptyGrepPatternRejection("", undefined)).toBe("grep pattern is required (received an empty pattern).");
	});
	it("returns rejection with glob hint when pattern is empty and glob is set", () => {
		const result = emptyGrepPatternRejection(undefined, "*.ts");
		expect(result).toContain('To list files matching "*.ts"');
		expect(result).toContain("grep pattern is required");
	});
	it("returns rejection with glob hint when pattern is empty string and glob is set", () => {
		const result = emptyGrepPatternRejection("", "*.rs");
		expect(result).toContain('To list files matching "*.rs"');
	});
	it("returns rejection when pattern is whitespace-only", () => {
		expect(emptyGrepPatternRejection("   ", undefined)).toBe("grep pattern is required (received an empty pattern).");
	});
	it("returns generic rejection when pattern is empty and glob is empty", () => {
		expect(emptyGrepPatternRejection("", "")).toBe("grep pattern is required (received an empty pattern).");
	});
});

describe("createProviderErrorMessage", () => {
	it("creates error message with model info", () => {
		const model = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4",
		} as unknown as Model<"anthropic-messages">;
		const result = createProviderErrorMessage(model, new Error("test error"));
		expect(result.role).toBe("assistant");
		expect(result.stopReason).toBe("error");
		expect(result.api).toBe("anthropic-messages");
		expect(result.provider).toBe("anthropic");
		expect(result.model).toBe("claude-sonnet-4");
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("test error");
	});
	it("creates error message for string error", () => {
		const model = {
			api: "openai",
			provider: "openai",
			id: "gpt-4",
		} as unknown as Model<"openai">;
		const result = createProviderErrorMessage(model, "something went wrong");
		expect(result.stopReason).toBe("error");
		expect((result.content[0] as { text: string }).text).toContain("something went wrong");
	});
	it("includes usage object", () => {
		const model = {
			api: "google-generative-ai",
			provider: "google-generative-ai",
			id: "gemini-2.0-flash",
		} as unknown as Model<"google-generative-ai">;
		const result = createProviderErrorMessage(model, new Error("err"));
		expect(result.usage).toBeDefined();
		expect(typeof result.usage).toBe("object");
	});
	it("includes timestamp", () => {
		const model = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4",
		} as unknown as Model<"anthropic-messages">;
		const before = Date.now();
		const result = createProviderErrorMessage(model, "err");
		const after = Date.now();
		expect(result.timestamp).toBeGreaterThanOrEqual(before);
		expect(result.timestamp).toBeLessThanOrEqual(after);
	});
});
