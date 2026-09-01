import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import { deterministicUuid } from "../src/utils/deterministic-id";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../src/utils/google-validation";
import {
	assistantText,
	assistantTextBlocks,
	assistantTextBlocksFromUnknown,
	assistantTextFromUnknown,
} from "../src/utils/message-text";

describe("extractGoogleValidationUrl", () => {
	it("returns undefined when VALIDATION_REQUIRED not present", () => {
		expect(extractGoogleValidationUrl("some error")).toBeUndefined();
	});
	it("returns undefined when no JSON in body", () => {
		expect(extractGoogleValidationUrl("VALIDATION_REQUIRED no json here")).toBeUndefined();
	});
	it("extracts validation URL from valid JSON", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://example.com/verify" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBe("https://example.com/verify");
	});
	it("returns undefined when detail reason is not VALIDATION_REQUIRED", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "OTHER_REASON",
						metadata: { validation_url: "https://example.com/verify" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("returns undefined when validation_url is not a string", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: 123 },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("returns undefined when details array is empty", () => {
		const body = JSON.stringify({ error: { details: [] } });
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("handles invalid JSON gracefully", () => {
		expect(extractGoogleValidationUrl("VALIDATION_REQUIRED {invalid}")).toBeUndefined();
	});
	it("extracts URL from body with prefix text", () => {
		const body = `Error occurred: ${JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://verify.example.com" },
					},
				],
			},
		})}`;
		expect(extractGoogleValidationUrl(body)).toBe("https://verify.example.com");
	});
	it("finds first matching detail among multiple", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{ reason: "OTHER", metadata: {} },
					{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: "https://first.match" } },
					{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: "https://second.match" } },
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBe("https://first.match");
	});
});

describe("formatGoogleValidationRequiredMessage", () => {
	it("formats message with URL and action", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry the request");
		expect(msg).toContain("https://verify.example.com");
		expect(msg).toContain("retry the request");
		expect(msg).toContain("Account verification required");
	});
	it("includes email when provided", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry", "user@example.com");
		expect(msg).toContain("for user@example.com");
	});
	it("does not include email section when email is undefined", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry");
		expect(msg).not.toContain("for ");
	});
	it("does not include email section when email is empty", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry", "");
		expect(msg).not.toContain("for ");
	});
});

describe("assistantTextBlocks", () => {
	it("extracts text blocks from assistant message", () => {
		const msg = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "thoughts" },
				{ type: "text", text: "world" },
			],
		} as Pick<AssistantMessage, "content">;
		expect(assistantTextBlocks(msg)).toEqual(["hello", "world"]);
	});
	it("returns empty array for message with no text blocks", () => {
		const msg = {
			content: [{ type: "thinking", thinking: "thoughts" }],
		} as Pick<AssistantMessage, "content">;
		expect(assistantTextBlocks(msg)).toEqual([]);
	});
	it("returns empty array for empty content", () => {
		const msg = { content: [] } as Pick<AssistantMessage, "content">;
		expect(assistantTextBlocks(msg)).toEqual([]);
	});
});

describe("assistantText", () => {
	it("joins text blocks with newline by default", () => {
		const msg = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
		} as Pick<AssistantMessage, "content">;
		expect(assistantText(msg)).toBe("hello\nworld");
	});
	it("joins with custom separator", () => {
		const msg = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
		} as Pick<AssistantMessage, "content">;
		expect(assistantText(msg, " ")).toBe("hello world");
	});
	it("returns empty string for no text blocks", () => {
		const msg = { content: [] } as Pick<AssistantMessage, "content">;
		expect(assistantText(msg)).toBe("");
	});
	it("returns single text block as-is", () => {
		const msg = { content: [{ type: "text", text: "hello" }] } as Pick<AssistantMessage, "content">;
		expect(assistantText(msg)).toBe("hello");
	});
});

describe("assistantTextBlocksFromUnknown", () => {
	it("extracts text blocks from valid content array", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "text", text: "hello" },
				{ type: "image", data: "abc" },
				{ type: "text", text: "world" },
			]),
		).toEqual(["hello", "world"]);
	});
	it("returns empty array for non-array input", () => {
		expect(assistantTextBlocksFromUnknown("hello")).toEqual([]);
	});
	it("returns empty array for null", () => {
		expect(assistantTextBlocksFromUnknown(null)).toEqual([]);
	});
	it("returns empty array for undefined", () => {
		expect(assistantTextBlocksFromUnknown(undefined)).toEqual([]);
	});
	it("skips null entries in array", () => {
		expect(assistantTextBlocksFromUnknown([null, { type: "text", text: "hello" }])).toEqual(["hello"]);
	});
	it("skips non-object entries", () => {
		expect(assistantTextBlocksFromUnknown([42, "string", { type: "text", text: "hello" }])).toEqual(["hello"]);
	});
	it("skips entries with non-string text", () => {
		expect(assistantTextBlocksFromUnknown([{ type: "text", text: 123 }])).toEqual([]);
	});
	it("skips entries with wrong type", () => {
		expect(assistantTextBlocksFromUnknown([{ type: "thinking", text: "hello" }])).toEqual([]);
	});
	it("returns empty array for empty array", () => {
		expect(assistantTextBlocksFromUnknown([])).toEqual([]);
	});
});

describe("assistantTextFromUnknown", () => {
	it("joins text blocks with newline by default", () => {
		expect(
			assistantTextFromUnknown([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		).toBe("hello\nworld");
	});
	it("joins with custom separator", () => {
		expect(
			assistantTextFromUnknown(
				[
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
				" ",
			),
		).toBe("hello world");
	});
	it("returns empty string for non-array", () => {
		expect(assistantTextFromUnknown(null)).toBe("");
	});
	it("returns empty string for empty array", () => {
		expect(assistantTextFromUnknown([])).toBe("");
	});
});

describe("deterministicUuid", () => {
	it("returns a valid UUID format", () => {
		const uuid = deterministicUuid("test-seed");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
	it("is deterministic for same seed", () => {
		expect(deterministicUuid("test-seed")).toBe(deterministicUuid("test-seed"));
	});
	it("returns different UUIDs for different seeds", () => {
		expect(deterministicUuid("seed1")).not.toBe(deterministicUuid("seed2"));
	});
	it("returns different UUID for empty seed", () => {
		const uuid = deterministicUuid("");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
	it("returns consistent UUID for known seed", () => {
		// SHA256 of "test" starts with 9f86d081...
		expect(deterministicUuid("test")).toMatch(/^9f86d081-/);
	});
});
