import { describe, expect, it } from "bun:test";
import type { ToolChoice } from "../src/types";
import {
	isForcedToolChoice,
	mapToOpenAICompletionsToolChoice,
	mapToOpenAIResponsesToolChoice,
} from "../src/utils/tool-choice";

describe("mapToOpenAICompletionsToolChoice", () => {
	it("returns undefined for undefined input", () => {
		expect(mapToOpenAICompletionsToolChoice(undefined)).toBeUndefined();
	});

	it("maps 'auto' to 'auto'", () => {
		expect(mapToOpenAICompletionsToolChoice("auto")).toBe("auto");
	});

	it("maps 'none' to 'none'", () => {
		expect(mapToOpenAICompletionsToolChoice("none")).toBe("none");
	});

	it("maps 'required' to 'required'", () => {
		expect(mapToOpenAICompletionsToolChoice("required")).toBe("required");
	});

	it("maps 'any' to 'required'", () => {
		expect(mapToOpenAICompletionsToolChoice("any")).toBe("required");
	});

	it("maps tool choice with name to function format", () => {
		const choice: ToolChoice = { type: "tool", name: "read" };
		expect(mapToOpenAICompletionsToolChoice(choice)).toEqual({
			type: "function",
			function: { name: "read" },
		});
	});

	it("maps function choice with nested name to function format", () => {
		const choice: ToolChoice = {
			type: "function",
			function: { name: "write" },
		} as unknown as ToolChoice;
		expect(mapToOpenAICompletionsToolChoice(choice)).toEqual({
			type: "function",
			function: { name: "write" },
		});
	});

	it("maps function choice with flat name to function format", () => {
		const choice: ToolChoice = { type: "function", name: "edit" } as unknown as ToolChoice;
		expect(mapToOpenAICompletionsToolChoice(choice)).toEqual({
			type: "function",
			function: { name: "edit" },
		});
	});

	it("returns undefined for unrecognized string", () => {
		expect(mapToOpenAICompletionsToolChoice("unknown" as unknown as ToolChoice)).toBeUndefined();
	});
});

describe("mapToOpenAIResponsesToolChoice", () => {
	it("returns undefined for undefined input", () => {
		expect(mapToOpenAIResponsesToolChoice(undefined)).toBeUndefined();
	});

	it("maps 'auto' to 'auto'", () => {
		expect(mapToOpenAIResponsesToolChoice("auto")).toBe("auto");
	});

	it("maps 'none' to 'none'", () => {
		expect(mapToOpenAIResponsesToolChoice("none")).toBe("none");
	});

	it("maps 'required' to 'required'", () => {
		expect(mapToOpenAIResponsesToolChoice("required")).toBe("required");
	});

	it("maps 'any' to 'required'", () => {
		expect(mapToOpenAIResponsesToolChoice("any")).toBe("required");
	});

	it("maps tool choice with name to flat function format", () => {
		const choice: ToolChoice = { type: "tool", name: "read" };
		expect(mapToOpenAIResponsesToolChoice(choice)).toEqual({
			type: "function",
			name: "read",
		});
	});

	it("maps function choice with nested name to flat function format", () => {
		const choice: ToolChoice = {
			type: "function",
			function: { name: "write" },
		} as unknown as ToolChoice;
		expect(mapToOpenAIResponsesToolChoice(choice)).toEqual({
			type: "function",
			name: "write",
		});
	});

	it("returns undefined for unrecognized string", () => {
		expect(mapToOpenAIResponsesToolChoice("unknown" as unknown as ToolChoice)).toBeUndefined();
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

	it("returns true for object choice", () => {
		expect(isForcedToolChoice({ type: "function", name: "read" })).toBe(true);
	});

	it("returns true for unknown string", () => {
		expect(isForcedToolChoice("unknown")).toBe(true);
	});

	it("returns true for null", () => {
		expect(isForcedToolChoice(null)).toBe(true);
	});

	it("returns true for 0", () => {
		expect(isForcedToolChoice(0)).toBe(true);
	});
});
