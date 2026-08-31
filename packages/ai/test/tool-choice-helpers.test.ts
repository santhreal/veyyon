import { describe, expect, it } from "bun:test";
import {
	isForcedToolChoice,
	mapToOpenAICompletionsToolChoice,
	mapToOpenAIResponsesToolChoice,
} from "../src/utils/tool-choice";

describe("mapToOpenAICompletionsToolChoice", () => {
	it("returns undefined for undefined", () => {
		expect(mapToOpenAICompletionsToolChoice(undefined)).toBeUndefined();
	});
	it("maps 'auto' to 'auto'", () => {
		expect(mapToOpenAICompletionsToolChoice("auto")).toBe("auto");
	});
	it("maps 'none' to 'none'", () => {
		expect(mapToOpenAICompletionsToolChoice("none")).toBe("none");
	});
	it("maps 'any' to 'required'", () => {
		expect(mapToOpenAICompletionsToolChoice("any")).toBe("required");
	});
	it("maps 'required' to 'required'", () => {
		expect(mapToOpenAICompletionsToolChoice("required")).toBe("required");
	});
	it("maps function choice with name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "function", name: "my_tool" })).toEqual({
			type: "function",
			function: { name: "my_tool" },
		});
	});
	it("maps function choice with nested function object", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "function", function: { name: "my_tool" } })).toEqual({
			type: "function",
			function: { name: "my_tool" },
		});
	});
	it("maps tool choice with name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "tool", name: "my_tool" })).toEqual({
			type: "function",
			function: { name: "my_tool" },
		});
	});
	it("returns undefined for unrecognized string", () => {
		expect(mapToOpenAICompletionsToolChoice("unknown" as never)).toBeUndefined();
	});
	it("returns undefined for choice without name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "function" } as never)).toBeUndefined();
	});
});

describe("mapToOpenAIResponsesToolChoice", () => {
	it("returns undefined for undefined", () => {
		expect(mapToOpenAIResponsesToolChoice(undefined)).toBeUndefined();
	});
	it("maps 'auto' to 'auto'", () => {
		expect(mapToOpenAIResponsesToolChoice("auto")).toBe("auto");
	});
	it("maps 'none' to 'none'", () => {
		expect(mapToOpenAIResponsesToolChoice("none")).toBe("none");
	});
	it("maps 'any' to 'required'", () => {
		expect(mapToOpenAIResponsesToolChoice("any")).toBe("required");
	});
	it("maps 'required' to 'required'", () => {
		expect(mapToOpenAIResponsesToolChoice("required")).toBe("required");
	});
	it("maps function choice with name", () => {
		expect(mapToOpenAIResponsesToolChoice({ type: "function", name: "my_tool" })).toEqual({
			type: "function",
			name: "my_tool",
		});
	});
	it("maps function choice with nested function object", () => {
		expect(mapToOpenAIResponsesToolChoice({ type: "function", function: { name: "my_tool" } })).toEqual({
			type: "function",
			name: "my_tool",
		});
	});
	it("maps tool choice with name", () => {
		expect(mapToOpenAIResponsesToolChoice({ type: "tool", name: "my_tool" })).toEqual({
			type: "function",
			name: "my_tool",
		});
	});
	it("returns undefined for unrecognized string", () => {
		expect(mapToOpenAIResponsesToolChoice("unknown" as never)).toBeUndefined();
	});
});

describe("isForcedToolChoice", () => {
	it("returns false for undefined", () => {
		expect(isForcedToolChoice(undefined)).toBe(false);
	});
	it("returns false for 'auto'", () => {
		expect(isForcedToolChoice("auto")).toBe(false);
	});
	it("returns false for 'none'", () => {
		expect(isForcedToolChoice("none")).toBe(false);
	});
	it("returns true for 'required'", () => {
		expect(isForcedToolChoice("required")).toBe(true);
	});
	it("returns true for 'any'", () => {
		expect(isForcedToolChoice("any")).toBe(true);
	});
	it("returns true for function choice object", () => {
		expect(isForcedToolChoice({ type: "function", name: "my_tool" })).toBe(true);
	});
	it("returns true for unknown string", () => {
		expect(isForcedToolChoice("unknown")).toBe(true);
	});
});
