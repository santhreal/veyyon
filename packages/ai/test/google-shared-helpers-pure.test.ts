import { describe, expect, it } from "bun:test";
import {
	EMPTY_STREAM_BASE_DELAY_MS,
	extractGoogleErrorMessage,
	hasMeaningfulGoogleContent,
	MAX_EMPTY_STREAM_RETRIES,
	mapStopReasonString,
	mapToolChoice,
} from "../src/providers/google-shared-helpers";
import type { AssistantMessage } from "../src/types";

describe("MAX_EMPTY_STREAM_RETRIES", () => {
	it("is 2", () => {
		expect(MAX_EMPTY_STREAM_RETRIES).toBe(2);
	});
});

describe("EMPTY_STREAM_BASE_DELAY_MS", () => {
	it("is 500", () => {
		expect(EMPTY_STREAM_BASE_DELAY_MS).toBe(500);
	});
});

describe("mapToolChoice", () => {
	it("maps 'auto' to 'AUTO'", () => {
		expect(mapToolChoice("auto")).toBe("AUTO");
	});
	it("maps 'none' to 'NONE'", () => {
		expect(mapToolChoice("none")).toBe("NONE");
	});
	it("maps 'any' to 'ANY'", () => {
		expect(mapToolChoice("any")).toBe("ANY");
	});
	it("maps unknown to 'AUTO'", () => {
		expect(mapToolChoice("unknown")).toBe("AUTO");
	});
	it("maps empty string to 'AUTO'", () => {
		expect(mapToolChoice("")).toBe("AUTO");
	});
});

describe("mapStopReasonString", () => {
	it("maps 'STOP' to 'stop'", () => {
		expect(mapStopReasonString("STOP")).toBe("stop");
	});
	it("maps 'MAX_TOKENS' to 'length'", () => {
		expect(mapStopReasonString("MAX_TOKENS")).toBe("length");
	});
	it("maps unknown to 'error'", () => {
		expect(mapStopReasonString("UNKNOWN")).toBe("error");
	});
	it("maps empty string to 'error'", () => {
		expect(mapStopReasonString("")).toBe("error");
	});
});

describe("hasMeaningfulGoogleContent", () => {
	function makeOutput(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-pro",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 0,
			...overrides,
		} as unknown as AssistantMessage;
	}
	it("returns false for empty content", () => {
		expect(hasMeaningfulGoogleContent(makeOutput({ content: [] }))).toBe(false);
	});
	it("returns true for text content", () => {
		expect(hasMeaningfulGoogleContent(makeOutput({ content: [{ type: "text", text: "hello" }] }))).toBe(true);
	});
	it("returns true for tool call content", () => {
		expect(
			hasMeaningfulGoogleContent(makeOutput({ content: [{ type: "toolCall", id: "1", name: "test", input: {} }] })),
		).toBe(true);
	});
	it("returns false for thinking-only content", () => {
		expect(hasMeaningfulGoogleContent(makeOutput({ content: [{ type: "thinking", text: "hmm" }] }))).toBe(false);
	});
});

describe("extractGoogleErrorMessage", () => {
	it("returns 'Unknown error' for empty body text", () => {
		expect(extractGoogleErrorMessage({ text: "", detail: "detail", bytesRead: 0, truncated: false })).toBe(
			"Unknown error",
		);
	});
	it("extracts error.message from JSON", () => {
		const body = {
			text: JSON.stringify({ error: { message: "something failed" } }),
			detail: "raw",
			bytesRead: 30,
			truncated: false,
		};
		expect(extractGoogleErrorMessage(body)).toBe("something failed");
	});
	it("returns detail for invalid JSON", () => {
		const body = { text: "not json", detail: "raw detail", bytesRead: 8, truncated: false };
		expect(extractGoogleErrorMessage(body)).toBe("raw detail");
	});
	it("returns detail when JSON has no error.message", () => {
		const body = { text: JSON.stringify({ unrelated: "field" }), detail: "raw", bytesRead: 20, truncated: false };
		expect(extractGoogleErrorMessage(body)).toBe("raw");
	});
	it("returns detail when error.message is empty", () => {
		const body = { text: JSON.stringify({ error: { message: "" } }), detail: "raw", bytesRead: 25, truncated: false };
		expect(extractGoogleErrorMessage(body)).toBe("raw");
	});
});
