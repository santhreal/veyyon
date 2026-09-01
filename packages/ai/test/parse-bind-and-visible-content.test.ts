/**
 * WHY: `parseBind` parses a `host:port` or bare `port` bind string into a
 * `{ hostname, port }` pair, throwing `ConfigurationError` on every malformed
 * input. It is the one boundary between CLI configuration and the HTTP
 * listener — a bug here either binds the wrong interface, accepts an invalid
 * port silently, or throws a confusing error. It had zero tests.
 *
 * `hasVisibleAssistantContent` is the gatekeeper that decides whether an
 * assistant message carries real content (text or tool calls) or is an empty
 * completion that should trigger a retry. A false positive retries a valid
 * response; a false negative accepts a blank one. It had no behavior test
 * (only a source-grep lock).
 *
 * This suite closes the class by covering every branch of both functions:
 * all valid bind forms, every error path, all content block types, and the
 * whitespace-only text edge case.
 */
import { describe, expect, it } from "bun:test";
import { ConfigurationError } from "../src/error";
import type { AssistantMessage, ToolCall } from "../src/types";
import { hasVisibleAssistantContent } from "../src/utils/empty-completion-retry";
import { parseBind } from "../src/utils/parse-bind";

// ─── parseBind ────────────────────────────────────────────────────

describe("parseBind", () => {
	describe("valid inputs", () => {
		it("parses a bare port with default hostname", () => {
			expect(parseBind("8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
		});

		it("parses host:port", () => {
			expect(parseBind("0.0.0.0:3000")).toEqual({ hostname: "0.0.0.0", port: 3000 });
		});

		it("parses localhost:port", () => {
			expect(parseBind("localhost:9000")).toEqual({ hostname: "localhost", port: 9000 });
		});

		it("parses IPv6 address with port", () => {
			expect(parseBind("[::1]:4444")).toEqual({ hostname: "[::1]", port: 4444 });
		});

		it("parses a full IPv6 address with port", () => {
			expect(parseBind("[2001:db8::1]:80")).toEqual({ hostname: "[2001:db8::1]", port: 80 });
		});

		it("trims whitespace before parsing", () => {
			expect(parseBind("  8080  ")).toEqual({ hostname: "127.0.0.1", port: 8080 });
			expect(parseBind("  localhost:3000  ")).toEqual({ hostname: "localhost", port: 3000 });
		});

		it("accepts port 0", () => {
			expect(parseBind("0")).toEqual({ hostname: "127.0.0.1", port: 0 });
		});

		it("accepts port 65535", () => {
			expect(parseBind("65535")).toEqual({ hostname: "127.0.0.1", port: 65535 });
		});
	});

	describe("error paths", () => {
		it("throws on empty string", () => {
			expect(() => parseBind("")).toThrow(ConfigurationError);
			expect(() => parseBind("")).toThrow("expected 'host:port' or 'port'");
		});

		it("throws on whitespace-only string", () => {
			expect(() => parseBind("   ")).toThrow(ConfigurationError);
			expect(() => parseBind("   ")).toThrow("expected 'host:port' or 'port'");
		});

		it("throws on non-numeric port", () => {
			expect(() => parseBind("localhost:abc")).toThrow(ConfigurationError);
			expect(() => parseBind("localhost:abc")).toThrow("port must be an integer");
		});

		it("throws on negative port", () => {
			expect(() => parseBind("-1")).toThrow(ConfigurationError);
		});

		it("throws on port out of range (too high)", () => {
			expect(() => parseBind("65536")).toThrow(ConfigurationError);
			expect(() => parseBind("65536")).toThrow("port out of range");
		});

		it("throws on port with decimal", () => {
			expect(() => parseBind("80.5")).toThrow(ConfigurationError);
		});

		it("throws on missing port", () => {
			expect(() => parseBind("localhost:")).toThrow(ConfigurationError);
		});

		it("throws on missing colon and non-numeric", () => {
			expect(() => parseBind("localhost")).toThrow(ConfigurationError);
			expect(() => parseBind("localhost")).toThrow("expected 'host:port' or 'port'");
		});

		it("throws on empty host before colon", () => {
			expect(() => parseBind(":8080")).toThrow(ConfigurationError);
			expect(() => parseBind(":8080")).toThrow("host must not be empty");
		});

		it("throws on port with trailing characters", () => {
			expect(() => parseBind("localhost:8080extra")).toThrow(ConfigurationError);
		});
	});
});

// ─── hasVisibleAssistantContent ───────────────────────────────────

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function textBlock(text: string) {
	return { type: "text" as const, text };
}

function toolCallBlock(id: string = "call-1"): ToolCall {
	return { type: "toolCall" as const, id, name: "read", arguments: {} };
}

function thinkingBlock(text: string) {
	return { type: "thinking" as const, thinking: text };
}

describe("hasVisibleAssistantContent", () => {
	it("returns false for empty content", () => {
		expect(hasVisibleAssistantContent(makeAssistant([]))).toBe(false);
	});

	it("returns true for a text block with visible content", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("hello")]))).toBe(true);
	});

	it("returns false for a text block with only whitespace", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("   \n\t  ")]))).toBe(false);
	});
	it("returns false for an empty text block", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("")]))).toBe(false);
	});

	it("returns true for a tool call block", () => {
		expect(hasVisibleAssistantContent(makeAssistant([toolCallBlock()]))).toBe(true);
	});

	it("returns false for a thinking-only block", () => {
		expect(hasVisibleAssistantContent(makeAssistant([thinkingBlock("reasoning...")]))).toBe(false);
	});

	it("returns false for multiple thinking blocks", () => {
		expect(hasVisibleAssistantContent(makeAssistant([thinkingBlock("step 1"), thinkingBlock("step 2")]))).toBe(false);
	});

	it("returns true when text block follows thinking blocks", () => {
		expect(hasVisibleAssistantContent(makeAssistant([thinkingBlock("hmm"), textBlock("answer")]))).toBe(true);
	});

	it("returns true when tool call follows whitespace text", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("  "), toolCallBlock()]))).toBe(true);
	});

	it("returns false when only whitespace text and thinking blocks exist", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("  "), thinkingBlock("...")]))).toBe(false);
	});

	it("returns true for text with leading whitespace and visible content", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("  visible  ")]))).toBe(true);
	});

	it("returns true for a single newline-then-content text block", () => {
		expect(hasVisibleAssistantContent(makeAssistant([textBlock("\nhello")]))).toBe(true);
	});
});
