import { describe, expect, it } from "bun:test";
import {
	assistantTranscriptParts,
	collectToolResultRun,
	geminiTurn,
	gemmaTurn,
	harmonyRecipient,
	joinUserBodies,
	kimiCallId,
	kimiTurn,
	messageContentText,
	renderDelimitedThinking,
	renderFunctionResults,
	renderInvoke,
	renderInvokes,
	renderThinkTags,
	renderToolResponseResults,
	renderXmlThinkingTags,
	stringifyJson,
} from "../src/dialect/rendering";
import { THINK_CLOSE, THINK_OPEN, TOOL_RESPONSE_CLOSE, TOOL_RESPONSE_OPEN } from "../src/dialect/wire-tags";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../src/types";

describe("stringifyJson", () => {
	it("stringifies object", () => {
		expect(stringifyJson({ a: 1 })).toBe('{"a":1}');
	});
	it("stringifies array", () => {
		expect(stringifyJson([1, 2])).toBe("[1,2]");
	});
	it("returns 'null' for null", () => {
		expect(stringifyJson(null)).toBe("null");
	});
	it("stringifies string", () => {
		expect(stringifyJson("hello")).toBe('"hello"');
	});
	it("stringifies number", () => {
		expect(stringifyJson(42)).toBe("42");
	});
});

describe("kimiCallId", () => {
	it("returns id if already prefixed with functions.", () => {
		expect(kimiCallId("getWeather", "functions.getWeather:0", 0)).toBe("functions.getWeather:0");
	});
	it("constructs id from name and index", () => {
		expect(kimiCallId("getWeather", "abc", 2)).toBe("functions.getWeather:2");
	});
	it("trims id whitespace", () => {
		expect(kimiCallId("getWeather", "  functions.getWeather:0  ", 0)).toBe("functions.getWeather:0");
	});
});

describe("harmonyRecipient", () => {
	it("returns name unchanged if already prefixed", () => {
		expect(harmonyRecipient("functions.getWeather")).toBe("functions.getWeather");
	});
	it("prefixes with functions.", () => {
		expect(harmonyRecipient("getWeather")).toBe("functions.getWeather");
	});
});

describe("renderDelimitedThinking", () => {
	it("returns empty string for empty text", () => {
		expect(renderDelimitedThinking("<think>", "</think>", "")).toBe("");
	});
	it("wraps text with open and close tags", () => {
		expect(renderDelimitedThinking("<think>", "</think>", "hello")).toBe("<think>\nhello\n</think>");
	});
	it("unwraps existing thinking tags", () => {
		expect(renderDelimitedThinking("<think>", "</think>", "<think>\nhello\n</think>")).toBe(
			"<think>\nhello\n</think>",
		);
	});
});

describe("renderThinkTags", () => {
	it("returns empty for empty text", () => {
		expect(renderThinkTags("")).toBe("");
	});
	it("wraps text with think tags", () => {
		expect(renderThinkTags("hello")).toBe(`${THINK_OPEN}\nhello\n${THINK_CLOSE}`);
	});
});

describe("renderXmlThinkingTags", () => {
	it("returns empty for empty text", () => {
		expect(renderXmlThinkingTags("")).toBe("");
	});
	it("wraps text with XML thinking tags", () => {
		expect(renderXmlThinkingTags("hello")).toBe(`<thinking>\nhello\n</thinking>`);
	});
});

describe("kimiTurn", () => {
	it("renders user turn", () => {
		expect(kimiTurn("user", "test", "hello")).toBe("<|im_user|>test<|im_middle|>hello<|im_end|>");
	});
	it("renders assistant turn", () => {
		expect(kimiTurn("assistant", "ai", "response")).toBe("<|im_assistant|>ai<|im_middle|>response<|im_end|>");
	});
});

describe("gemmaTurn", () => {
	it("renders user turn", () => {
		expect(gemmaTurn("user", "hello")).toBe("<|turn>user\nhello<turn|>");
	});
	it("renders model turn", () => {
		expect(gemmaTurn("model", "response")).toBe("<|turn>model\nresponse<turn|>");
	});
});

describe("geminiTurn", () => {
	it("renders user turn", () => {
		expect(geminiTurn("user", "hello")).toBe("<start_of_turn>user\nhello<end_of_turn>\n");
	});
	it("renders model turn", () => {
		expect(geminiTurn("model", "response")).toBe("<start_of_turn>model\nresponse<end_of_turn>\n");
	});
});

describe("joinUserBodies", () => {
	it("returns right for empty left", () => {
		expect(joinUserBodies("", "hello")).toBe("hello");
	});
	it("returns left for empty right", () => {
		expect(joinUserBodies("hello", "")).toBe("hello");
	});
	it("joins with newline", () => {
		expect(joinUserBodies("hello", "world")).toBe("hello\nworld");
	});
});

describe("messageContentText", () => {
	it("returns string content unchanged", () => {
		expect(messageContentText("hello")).toBe("hello");
	});
	it("extracts text from content blocks", () => {
		expect(messageContentText([{ type: "text", text: "hello" }])).toBe("hello");
	});
	it("concatenates multiple text blocks", () => {
		expect(
			messageContentText([
				{ type: "text", text: "hello" },
				{ type: "text", text: " world" },
			]),
		).toBe("hello world");
	});
	it("renders image block with mimeType", () => {
		expect(messageContentText([{ type: "image", mimeType: "image/png" }])).toBe("[Image: image/png]");
	});
	it("renders image block without mimeType", () => {
		expect(messageContentText([{ type: "image" }])).toBe("[Image]");
	});
	it("returns empty for empty content array", () => {
		expect(messageContentText([])).toBe("");
	});
	it("skips blocks without text", () => {
		expect(messageContentText([{ type: "text" }])).toBe("");
	});
});

describe("assistantTranscriptParts", () => {
	it("extracts text from simple message", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
		};
		const parts = assistantTranscriptParts(msg);
		expect(parts.text).toBe("hello");
		expect(parts.thinking).toBe("");
		expect(parts.toolCalls).toEqual([]);
	});
	it("extracts thinking blocks", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "thinking", thinking: "ah" },
			],
		};
		const parts = assistantTranscriptParts(msg);
		expect(parts.thinking).toBe("hmm\nah");
		expect(parts.text).toBe("");
	});
	it("extracts tool calls", () => {
		const call: ToolCall = { name: "getWeather", arguments: { city: "NYC" }, id: "call_1" };
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", name: call.name, arguments: call.arguments, id: call.id }],
		};
		const parts = assistantTranscriptParts(msg);
		expect(parts.toolCalls).toHaveLength(1);
		expect(parts.toolCalls[0]!.name).toBe("getWeather");
	});
});

describe("collectToolResultRun", () => {
	it("collects consecutive tool result messages", () => {
		const messages: Message[] = [
			{ role: "toolResult", toolCallId: "1", toolName: "foo", content: "result1", isError: false },
			{ role: "toolResult", toolCallId: "2", toolName: "bar", content: "result2", isError: false },
			{ role: "user", content: "next" },
		];
		const { results, next } = collectToolResultRun(messages, 0);
		expect(results).toHaveLength(2);
		expect(next).toBe(2);
	});
	it("returns empty for non-toolResult start", () => {
		const messages: Message[] = [{ role: "user", content: "hello" }];
		const { results, next } = collectToolResultRun(messages, 0);
		expect(results).toEqual([]);
		expect(next).toBe(0);
	});
	it("stops at first non-toolResult", () => {
		const messages: Message[] = [
			{ role: "toolResult", toolCallId: "1", toolName: "foo", content: "r1", isError: false },
			{ role: "user", content: "break" },
			{ role: "toolResult", toolCallId: "2", toolName: "bar", content: "r2", isError: false },
		];
		const { results, next } = collectToolResultRun(messages, 0);
		expect(results).toHaveLength(1);
		expect(next).toBe(1);
	});
});

describe("renderToolResponseResults", () => {
	it("renders single result", () => {
		const result = renderToolResponseResults([{ name: "foo", text: "output", index: 0, isError: false }]);
		expect(result).toBe(`${TOOL_RESPONSE_OPEN}\noutput\n${TOOL_RESPONSE_CLOSE}`);
	});
	it("renders multiple results joined with newline", () => {
		const result = renderToolResponseResults([
			{ name: "foo", text: "out1", index: 0, isError: false },
			{ name: "bar", text: "out2", index: 1, isError: false },
		]);
		expect(result).toContain("out1");
		expect(result).toContain("out2");
	});
	it("returns empty string for empty results", () => {
		expect(renderToolResponseResults([])).toBe("");
	});
});

describe("renderFunctionResults", () => {
	it("renders success result", () => {
		const result = renderFunctionResults([{ name: "foo", text: "output", index: 0, isError: false }]);
		expect(result).toContain("<result>");
		expect(result).toContain("<tool_name>foo</tool_name>");
		expect(result).toContain("<stdout>output</stdout>");
	});
	it("renders error result", () => {
		const result = renderFunctionResults([{ name: "foo", text: "error msg", index: 0, isError: true }]);
		expect(result).toContain("<error>");
		expect(result).toContain("<stderr>error msg</stderr>");
	});
});

describe("renderInvoke", () => {
	it("renders invoke with arguments", () => {
		const call: ToolCall = { name: "getWeather", arguments: { city: "NYC" }, id: "1" };
		const result = renderInvoke(call, undefined);
		expect(result).toContain('name="getWeather"');
		expect(result).toContain('name="city"');
		expect(result).toContain('"NYC"');
	});
	it("renders empty invoke for no arguments", () => {
		const call: ToolCall = { name: "noop", arguments: {}, id: "1" };
		const result = renderInvoke(call, undefined);
		expect(result).toBe('<invoke name="noop"></invoke>');
	});
	it("escapes XML in name", () => {
		const call: ToolCall = { name: "a<b", arguments: {}, id: "1" };
		const result = renderInvoke(call, undefined);
		expect(result).toContain("a&lt;b");
	});
});

describe("renderInvokes", () => {
	it("renders multiple invokes", () => {
		const calls: ToolCall[] = [
			{ name: "foo", arguments: { x: 1 }, id: "1" },
			{ name: "bar", arguments: {}, id: "2" },
		];
		const result = renderInvokes(calls, []);
		expect(result).toContain('name="foo"');
		expect(result).toContain('name="bar"');
	});
	it("returns empty string for empty calls", () => {
		expect(renderInvokes([], [])).toBe("");
	});
});
