import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import {
	abortReasonText,
	buildToolCallAbortMessages,
	executedToolCallIds,
	isStringRecord,
	storedToolCallIds,
	syntheticDetailsFor,
	toolScopedAbortReason,
} from "../src/agent-loop-helpers";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "anthropic" as never,
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: { input: 10, output: 5 } as never,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function makeToolResultMessage(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
		...overrides,
	};
}

describe("isStringRecord", () => {
	it("returns true for object with all string values", () => {
		expect(isStringRecord({ a: "x", b: "y" })).toBe(true);
	});

	it("returns true for empty object", () => {
		expect(isStringRecord({})).toBe(true);
	});

	it("returns false for object with non-string value", () => {
		expect(isStringRecord({ a: 1 })).toBe(false);
		expect(isStringRecord({ a: true })).toBe(false);
		expect(isStringRecord({ a: null })).toBe(false);
		expect(isStringRecord({ a: undefined })).toBe(false);
		expect(isStringRecord({ a: {} })).toBe(false);
	});

	it("returns false for null", () => {
		expect(isStringRecord(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isStringRecord(undefined)).toBe(false);
	});

	it("returns false for array", () => {
		expect(isStringRecord(["a", "b"])).toBe(false);
	});

	it("returns false for string", () => {
		expect(isStringRecord("hello")).toBe(false);
	});

	it("returns false for number", () => {
		expect(isStringRecord(42)).toBe(false);
	});
});

describe("toolScopedAbortReason", () => {
	function makeSignal(reason: unknown): AbortSignal {
		const controller = new AbortController();
		controller.abort(reason);
		return controller.signal;
	}

	it("returns undefined for undefined signal", () => {
		expect(toolScopedAbortReason(undefined)).toBeUndefined();
	});

	it("returns undefined for default abort (DOMException)", () => {
		const controller = new AbortController();
		controller.abort();
		expect(toolScopedAbortReason(controller.signal)).toBeUndefined();
	});

	it("returns undefined for string reason", () => {
		expect(toolScopedAbortReason(makeSignal("cancelled"))).toBeUndefined();
	});

	it("returns undefined for object without kind", () => {
		expect(toolScopedAbortReason(makeSignal({ message: "hi" }))).toBeUndefined();
	});

	it("returns undefined for object with wrong kind", () => {
		expect(
			toolScopedAbortReason(
				makeSignal({ kind: "other", message: "hi", defaultToolCallMessage: "msg", toolCallMessages: {} }),
			),
		).toBeUndefined();
	});

	it("returns undefined when message is not a string", () => {
		expect(
			toolScopedAbortReason(
				makeSignal({
					kind: "tool-scoped-abort",
					message: 123,
					defaultToolCallMessage: "msg",
					toolCallMessages: {},
				}),
			),
		).toBeUndefined();
	});

	it("returns undefined when defaultToolCallMessage is not a string", () => {
		expect(
			toolScopedAbortReason(
				makeSignal({
					kind: "tool-scoped-abort",
					message: "hi",
					defaultToolCallMessage: 123,
					toolCallMessages: {},
				}),
			),
		).toBeUndefined();
	});

	it("returns undefined when toolCallMessages is not a string record", () => {
		expect(
			toolScopedAbortReason(
				makeSignal({
					kind: "tool-scoped-abort",
					message: "hi",
					defaultToolCallMessage: "msg",
					toolCallMessages: { a: 1 },
				}),
			),
		).toBeUndefined();
	});

	it("returns the reason for valid tool-scoped abort", () => {
		const reason = {
			kind: "tool-scoped-abort",
			message: "User interrupted",
			defaultToolCallMessage: "Tool was interrupted",
			toolCallMessages: { tc1: "Specific message" },
		} as never;
		const result = toolScopedAbortReason(makeSignal(reason));
		expect(result).toBe(reason);
	});

	it("returns the reason with empty toolCallMessages", () => {
		const reason = {
			kind: "tool-scoped-abort",
			message: "Interrupted",
			defaultToolCallMessage: "Default",
			toolCallMessages: {},
		} as never;
		expect(toolScopedAbortReason(makeSignal(reason))).toBe(reason);
	});
});

describe("buildToolCallAbortMessages", () => {
	const validReason = {
		kind: "tool-scoped-abort",
		message: "Interrupted",
		defaultToolCallMessage: "Tool was interrupted",
		toolCallMessages: { tc1: "Specific message for tc1" },
	} as never;

	it("returns undefined when message has no toolCall blocks", () => {
		const msg = makeAssistantMessage({ content: [{ type: "text", text: "hi" }] });
		expect(buildToolCallAbortMessages(msg, validReason)).toBeUndefined();
	});

	it("returns map of tool call id to specific message", () => {
		const msg = makeAssistantMessage({
			content: [
				{ type: "toolCall", id: "tc1", name: "read", input: {} } as never,
				{ type: "toolCall", id: "tc2", name: "write", input: {} } as never,
			],
		});
		const result = buildToolCallAbortMessages(msg, validReason);
		expect(result).toEqual({
			tc1: "Specific message for tc1",
			tc2: "Tool was interrupted",
		});
	});

	it("uses defaultToolCallMessage for ids not in toolCallMessages", () => {
		const msg = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tcX", name: "read", input: {} } as never],
		});
		const result = buildToolCallAbortMessages(msg, validReason);
		expect(result).toEqual({ tcX: "Tool was interrupted" });
	});

	it("returns map even with single tool call", () => {
		const msg = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tc1", name: "read", input: {} } as never],
		});
		expect(buildToolCallAbortMessages(msg, validReason)).toEqual({ tc1: "Specific message for tc1" });
	});
});

describe("abortReasonText", () => {
	it("returns 'Request was aborted' for undefined signal", () => {
		expect(abortReasonText(undefined)).toBe("Request was aborted");
	});

	it("returns 'Request was aborted' for default abort", () => {
		const controller = new AbortController();
		controller.abort();
		expect(abortReasonText(controller.signal)).toBe("Request was aborted");
	});

	it("returns string reason when reason is a non-empty string", () => {
		const controller = new AbortController();
		controller.abort("User cancelled");
		expect(abortReasonText(controller.signal)).toBe("User cancelled");
	});

	it("returns 'Request was aborted' for empty string reason", () => {
		const controller = new AbortController();
		controller.abort("  ");
		expect(abortReasonText(controller.signal)).toBe("Request was aborted");
	});

	it("returns tool-scoped message when reason is tool-scoped abort", () => {
		const controller = new AbortController();
		controller.abort({
			kind: "tool-scoped-abort",
			message: "Scoped reason",
			defaultToolCallMessage: "Default",
			toolCallMessages: {},
		});
		expect(abortReasonText(controller.signal)).toBe("Scoped reason");
	});

	it("returns Error message for non-AbortError Error reason", () => {
		const controller = new AbortController();
		controller.abort(new Error("Custom error"));
		expect(abortReasonText(controller.signal)).toBe("Custom error");
	});

	it("returns 'Request was aborted' for Error with empty message", () => {
		const controller = new AbortController();
		controller.abort(new Error(""));
		expect(abortReasonText(controller.signal)).toBe("Request was aborted");
	});
});

describe("syntheticDetailsFor", () => {
	it("returns aborted source for 'aborted' reason", () => {
		const result = syntheticDetailsFor("aborted", undefined, undefined);
		expect(result.__synthetic).toBe(true);
		expect(result.source).toBe("assistant_stop_aborted");
		expect(result.executed).toBe(false);
		expect(result.upstreamError).toBeUndefined();
		expect(result.batchLedger).toBeUndefined();
	});

	it("returns error source for 'error' reason with message", () => {
		const result = syntheticDetailsFor("error", "Something broke", undefined);
		expect(result.source).toBe("assistant_stop_error");
		expect(result.upstreamError).toBe("Something broke");
	});

	it("returns error source for 'error' reason without message", () => {
		const result = syntheticDetailsFor("error", undefined, undefined);
		expect(result.source).toBe("assistant_stop_error");
		expect(result.upstreamError).toBeUndefined();
	});

	it("returns error source for 'error' reason with empty message", () => {
		const result = syntheticDetailsFor("error", "", undefined);
		expect(result.source).toBe("assistant_stop_error");
		expect(result.upstreamError).toBeUndefined();
	});

	it("returns skipped source for 'skipped' reason", () => {
		const result = syntheticDetailsFor("skipped", undefined, undefined);
		expect(result.source).toBe("assistant_stop_skipped");
	});

	it("returns length source for 'length' reason", () => {
		const result = syntheticDetailsFor("length", undefined, undefined);
		expect(result.source).toBe("assistant_stop_length");
	});

	it("includes batchLedger when provided", () => {
		const ledger = { cause: "abort" } as never;
		const result = syntheticDetailsFor("aborted", undefined, ledger);
		expect(result.batchLedger).toBe(ledger);
	});

	it("does not include batchLedger when undefined", () => {
		const result = syntheticDetailsFor("aborted", undefined, undefined);
		expect(result.batchLedger).toBeUndefined();
	});
});

describe("storedToolCallIds", () => {
	it("returns empty set for empty messages", () => {
		expect(storedToolCallIds([], false)).toEqual(new Set());
	});

	it("returns empty set for non-assistant messages", () => {
		expect(
			storedToolCallIds([{ role: "user", content: "hi" } as never, makeToolResultMessage() as never], false),
		).toEqual(new Set());
	});

	it("collects tool call ids from assistant messages", () => {
		const msg1 = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tc1", name: "read", input: {} } as never],
		});
		const msg2 = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tc2", name: "write", input: {} } as never],
		});
		expect(storedToolCallIds([msg1 as never, msg2 as never], false)).toEqual(new Set(["tc1", "tc2"]));
	});

	it("ignores non-toolCall blocks in assistant messages", () => {
		const msg = makeAssistantMessage({ content: [{ type: "text", text: "hi" }] });
		expect(storedToolCallIds([msg as never], false)).toEqual(new Set());
	});

	it("skipTrailing drops the last message", () => {
		const msg1 = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tc1", name: "read", input: {} } as never],
		});
		const msg2 = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tc2", name: "write", input: {} } as never],
		});
		expect(storedToolCallIds([msg1 as never, msg2 as never], true)).toEqual(new Set(["tc1"]));
	});

	it("skipTrailing with single message returns empty", () => {
		const msg = makeAssistantMessage({
			content: [{ type: "toolCall", id: "tc1", name: "read", input: {} } as never],
		});
		expect(storedToolCallIds([msg as never], true)).toEqual(new Set());
	});

	it("collects multiple tool calls from same message", () => {
		const msg = makeAssistantMessage({
			content: [
				{ type: "toolCall", id: "tc1", name: "read", input: {} } as never,
				{ type: "toolCall", id: "tc2", name: "write", input: {} } as never,
			],
		});
		expect(storedToolCallIds([msg as never], false)).toEqual(new Set(["tc1", "tc2"]));
	});
});

describe("executedToolCallIds", () => {
	it("returns empty set for empty messages", () => {
		expect(executedToolCallIds([])).toEqual(new Set());
	});

	it("collects ids from toolResult messages", () => {
		expect(
			executedToolCallIds([
				makeToolResultMessage({ toolCallId: "tc1" }) as never,
				makeToolResultMessage({ toolCallId: "tc2" }) as never,
			]),
		).toEqual(new Set(["tc1", "tc2"]));
	});

	it("ignores non-toolResult messages", () => {
		expect(executedToolCallIds([makeAssistantMessage() as never])).toEqual(new Set());
	});

	it("skips never-ran synthetic results", () => {
		expect(
			executedToolCallIds([
				makeToolResultMessage({ toolCallId: "tc1", details: { __synthetic: true, executed: false } }) as never,
			]),
		).toEqual(new Set());
	});

	it("includes real results (no details)", () => {
		expect(executedToolCallIds([makeToolResultMessage({ toolCallId: "tc1" }) as never])).toEqual(new Set(["tc1"]));
	});

	it("includes results with non-synthetic details", () => {
		expect(
			executedToolCallIds([makeToolResultMessage({ toolCallId: "tc1", details: { custom: true } }) as never]),
		).toEqual(new Set(["tc1"]));
	});

	it("skips skipped results that never entered", () => {
		expect(
			executedToolCallIds([
				makeToolResultMessage({ toolCallId: "tc1", details: { __skipped: true, entered: false } }) as never,
			]),
		).toEqual(new Set());
	});

	it("includes skipped results that did enter", () => {
		expect(
			executedToolCallIds([
				makeToolResultMessage({ toolCallId: "tc1", details: { __skipped: true, entered: true } }) as never,
			]),
		).toEqual(new Set(["tc1"]));
	});
});
