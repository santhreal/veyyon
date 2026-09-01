import { describe, expect, it } from "bun:test";
import { AnthropicStreamEnvelopeError, STREAM_ENVELOPE_ERROR_PREFIX } from "../src/error/classes";
import { create, Flag, is } from "../src/error/flag";
import {
	attach,
	classifyMessage,
	explain,
	isEmptyStreamEnvelopeError,
	isStreamEnvelopeError,
	isTransientStreamParseError,
	isUsageLimit,
	LLAMA_CPP_TOOL_CALL_PARSE_PATTERN,
} from "../src/error/flags";

describe("LLAMA_CPP_TOOL_CALL_PARSE_PATTERN", () => {
	it("matches 'failed to parse tool call arguments as json'", () => {
		expect(LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test("failed to parse tool call arguments as json")).toBe(true);
	});
	it("matches json.exception.parse_error.101", () => {
		expect(LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test("[json.exception.parse_error.101] bad")).toBe(true);
	});
	it("does not match unrelated text", () => {
		expect(LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test("unrelated error")).toBe(false);
	});
});

describe("isUsageLimit", () => {
	it("returns true for 'usage limit' error", () => {
		expect(isUsageLimit(new Error("usage limit exceeded"))).toBe(true);
	});
	it("returns true for 'quota exceeded' error", () => {
		expect(isUsageLimit(new Error("quota exceeded"))).toBe(true);
	});
	it("returns false for unrelated error", () => {
		expect(isUsageLimit(new Error("something else"))).toBe(false);
	});
	it("returns false for non-Error", () => {
		expect(isUsageLimit("string")).toBe(false);
		expect(isUsageLimit(42)).toBe(false);
	});
});

describe("isTransientStreamParseError", () => {
	it("returns true for 'truncated' message", () => {
		expect(isTransientStreamParseError(new Error("truncated response"))).toBe(true);
	});
	it("returns true for 'unexpected eof' message", () => {
		expect(isTransientStreamParseError(new Error("unexpected eof in stream"))).toBe(true);
	});
	it("returns true for 'unterminated string' message", () => {
		expect(isTransientStreamParseError(new Error("unterminated string at pos 5"))).toBe(true);
	});
	it("returns false for non-Error", () => {
		expect(isTransientStreamParseError("truncated")).toBe(false);
	});
	it("returns false for unrelated Error", () => {
		expect(isTransientStreamParseError(new Error("unrelated error"))).toBe(false);
	});
});

describe("isStreamEnvelopeError", () => {
	it("returns true for AnthropicStreamEnvelopeError", () => {
		expect(isStreamEnvelopeError(new AnthropicStreamEnvelopeError("bad thing"))).toBe(true);
	});
	it("returns true for message with STREAM_ENVELOPE_ERROR_PREFIX", () => {
		expect(isStreamEnvelopeError(new Error(`${STREAM_ENVELOPE_ERROR_PREFIX} something`))).toBe(true);
	});
	it("returns true for 'stream event order' message", () => {
		expect(isStreamEnvelopeError(new Error("stream event order violated"))).toBe(true);
	});
	it("returns true for 'before message_start' message", () => {
		expect(isStreamEnvelopeError(new Error("event before message_start"))).toBe(true);
	});
	it("returns false for non-Error", () => {
		expect(isStreamEnvelopeError("stream event order")).toBe(false);
	});
	it("returns false for unrelated Error", () => {
		expect(isStreamEnvelopeError(new Error("unrelated"))).toBe(false);
	});
});

describe("isEmptyStreamEnvelopeError", () => {
	it("returns true for envelope error with 'before message_start'", () => {
		const err = new Error(`${STREAM_ENVELOPE_ERROR_PREFIX} event before message_start`);
		expect(isEmptyStreamEnvelopeError(err)).toBe(true);
	});
	it("returns false for envelope error without 'before message_start'", () => {
		const err = new Error(`${STREAM_ENVELOPE_ERROR_PREFIX} other issue`);
		expect(isEmptyStreamEnvelopeError(err)).toBe(false);
	});
	it("returns false for 'before message_start' without envelope prefix", () => {
		expect(isEmptyStreamEnvelopeError(new Error("before message_start"))).toBe(false);
	});
	it("returns false for non-Error", () => {
		expect(isEmptyStreamEnvelopeError("test")).toBe(false);
	});
});

describe("attach", () => {
	it("attaches errorId as non-enumerable property", () => {
		const err = new Error("test");
		const id = create(Flag.Transient);
		const result = attach(err, id);
		expect(result).toBe(err);
		expect((err as { errorId?: number }).errorId).toBe(id);
		expect(Object.keys(err)).not.toContain("errorId");
	});
	it("allows overwriting existing errorId", () => {
		const err = new Error("test");
		attach(err, create(Flag.Transient));
		const newId = create(Flag.Timeout);
		attach(err, newId);
		expect((err as { errorId?: number }).errorId).toBe(newId);
	});
});

describe("classifyMessage", () => {
	it("classifies usage limit message", () => {
		const msg = { errorMessage: "usage limit exceeded", errorStatus: 429 };
		const id = classifyMessage(msg);
		expect(is(id, Flag.UsageLimit)).toBe(true);
	});
	it("classifies timeout message", () => {
		const msg = { errorMessage: "request timed out" };
		const id = classifyMessage(msg);
		expect(is(id, Flag.Timeout)).toBe(true);
	});
	it("preserves existing errorId", () => {
		const existingId = create(Flag.AuthFailed);
		const msg = { errorId: existingId, errorMessage: "some error" };
		const id = classifyMessage(msg);
		expect(is(id, Flag.AuthFailed)).toBe(true);
	});
	it("stores errorId on message", () => {
	const msg: { errorMessage: string; errorId?: number } = { errorMessage: "usage limit exceeded" };
		classifyMessage(msg);
		expect(typeof msg.errorId).toBe("number");
	});
	it("classifies bare status when no text", () => {
		const msg = { errorStatus: 500 };
		const id = classifyMessage(msg);
		expect(id).toBeGreaterThan(0);
	});
});

describe("explain", () => {
	it("returns id and rules for usage limit", () => {
		const result = explain(new Error("usage limit exceeded"));
		expect(result.id).toBeGreaterThan(0);
		expect(Array.isArray(result.rules)).toBe(true);
	});
	it("returns id and rules for timeout", () => {
		const result = explain(new Error("request timed out"));
		expect(result.id).toBeGreaterThan(0);
		expect(Array.isArray(result.rules)).toBe(true);
	});
	it("rules array is deduplicated", () => {
		const result = explain(new Error("usage limit exceeded"));
		const unique = new Set(result.rules);
		expect(unique.size).toBe(result.rules.length);
	});
	it("returns id 0 for empty error with no status", () => {
		const result = explain(new Error(""));
		expect(result.id).toBe(0);
	});
});
