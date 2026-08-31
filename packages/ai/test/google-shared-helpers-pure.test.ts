import { describe, expect, it } from "bun:test";
import {
	EMPTY_STREAM_BASE_DELAY_MS,
	extractGoogleErrorMessage,
	hasMeaningfulGoogleContent,
	MAX_EMPTY_STREAM_RETRIES,
	mapStopReason,
	mapStopReasonString,
	mapToolChoice,
	nextToolCallId,
} from "../src/providers/google-shared-helpers";
import type { AssistantMessage } from "../src/types";

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
		expect(mapToolChoice("unknown" as never)).toBe("AUTO");
	});
	it("maps empty string to 'AUTO'", () => {
		expect(mapToolChoice("")).toBe("AUTO");
	});
});

describe("mapStopReason", () => {
	it("maps STOP to 'stop'", () => {
		expect(mapStopReason("STOP")).toBe("stop");
	});
	it("maps MAX_TOKENS to 'length'", () => {
		expect(mapStopReason("MAX_TOKENS")).toBe("length");
	});
	it("maps SAFETY to 'error'", () => {
		expect(mapStopReason("SAFETY")).toBe("error");
	});
	it("maps RECITATION to 'error'", () => {
		expect(mapStopReason("RECITATION")).toBe("error");
	});
	it("maps BLOCKLIST to 'error'", () => {
		expect(mapStopReason("BLOCKLIST")).toBe("error");
	});
	it("maps PROHIBITED_CONTENT to 'error'", () => {
		expect(mapStopReason("PROHIBITED_CONTENT")).toBe("error");
	});
	it("maps MALFORMED_FUNCTION_CALL to 'error'", () => {
		expect(mapStopReason("MALFORMED_FUNCTION_CALL")).toBe("error");
	});
	it("maps OTHER to 'error'", () => {
		expect(mapStopReason("OTHER")).toBe("error");
	});
	it("maps FINISH_REASON_UNSPECIFIED to 'error'", () => {
		expect(mapStopReason("FINISH_REASON_UNSPECIFIED")).toBe("error");
	});
});

describe("mapStopReasonString", () => {
	it("maps STOP to 'stop'", () => {
		expect(mapStopReasonString("STOP")).toBe("stop");
	});
	it("maps MAX_TOKENS to 'length'", () => {
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
	it("returns false for empty content", () => {
		const output = { content: [] } as unknown as AssistantMessage;
		expect(hasMeaningfulGoogleContent(output)).toBe(false);
	});
	it("returns true for toolCall block", () => {
		const output = {
			content: [{ type: "toolCall", id: "1", name: "test", arguments: {} }],
		} as unknown as AssistantMessage;
		expect(hasMeaningfulGoogleContent(output)).toBe(true);
	});
	it("returns true for text block with content", () => {
		const output = { content: [{ type: "text", text: "hello" }] } as unknown as AssistantMessage;
		expect(hasMeaningfulGoogleContent(output)).toBe(true);
	});
	it("returns false for text block with only whitespace", () => {
		const output = { content: [{ type: "text", text: "   " }] } as unknown as AssistantMessage;
		expect(hasMeaningfulGoogleContent(output)).toBe(false);
	});
	it("returns false for text block with empty string", () => {
		const output = { content: [{ type: "text", text: "" }] } as unknown as AssistantMessage;
		expect(hasMeaningfulGoogleContent(output)).toBe(false);
	});
	it("returns true when at least one block has content", () => {
		const output = {
			content: [
				{ type: "text", text: "" },
				{ type: "text", text: "hello" },
			],
		} as unknown as AssistantMessage;
		expect(hasMeaningfulGoogleContent(output)).toBe(true);
	});
});

describe("nextToolCallId", () => {
	it("returns string with tool name prefix", () => {
		const id = nextToolCallId("myTool");
		expect(id.startsWith("myTool_")).toBe(true);
	});
	it("includes timestamp and counter", () => {
		const id = nextToolCallId("test");
		const parts = id.split("_");
		expect(parts.length).toBe(3);
		expect(parts[0]).toBe("test");
	});
	it("produces unique ids for consecutive calls", () => {
		const id1 = nextToolCallId("tool");
		const id2 = nextToolCallId("tool");
		expect(id1).not.toBe(id2);
	});
});

describe("constants", () => {
	it("MAX_EMPTY_STREAM_RETRIES is 2", () => {
		expect(MAX_EMPTY_STREAM_RETRIES).toBe(2);
	});
	it("EMPTY_STREAM_BASE_DELAY_MS is 500", () => {
		expect(EMPTY_STREAM_BASE_DELAY_MS).toBe(500);
	});
});

describe("extractGoogleErrorMessage", () => {
	it("returns 'Unknown error' for empty body text", () => {
		expect(extractGoogleErrorMessage({ text: "" } as never)).toBe("Unknown error");
	});
	it("returns 'Unknown error' for undefined body text", () => {
		expect(extractGoogleErrorMessage({} as never)).toBe("Unknown error");
	});
	it("extracts error message from JSON body", () => {
		const body = { text: '{"error":{"message":"Invalid API key"}}' } as never;
		expect(extractGoogleErrorMessage(body)).toBe("Invalid API key");
	});
	it("falls back to body.detail for non-JSON text", () => {
		const body = { text: "plain text error", detail: "detail message" } as never;
		expect(extractGoogleErrorMessage(body)).toBe("detail message");
	});
	it("falls back to body.detail for invalid JSON", () => {
		const body = { text: "{invalid json", detail: "fallback" } as never;
		expect(extractGoogleErrorMessage(body)).toBe("fallback");
	});
	it("falls back to body.detail when JSON has no error.message", () => {
		const body = { text: '{"other":"data"}', detail: "fallback" } as never;
		expect(extractGoogleErrorMessage(body)).toBe("fallback");
	});
});
