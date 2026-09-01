import { describe, expect, it } from "bun:test";
import type { ToolChoice } from "@veyyon/ai";
import {
	ANTHROPIC_OUTPUT_BLOCKED_PREFIX,
	defaultConvertToLlm,
	isAnthropicOutputBlockedError,
	refreshToolChoiceForActiveTools,
} from "../src/agent-helpers";
import type { AgentMessage, AgentTool } from "../src/types";

describe("defaultConvertToLlm", () => {
	it("filters to user, assistant, and toolResult messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "toolResult", content: [{ type: "text", text: "result" }], toolCallId: "call_1" },
		] as unknown as AgentMessage[];
		const result = defaultConvertToLlm(messages);
		expect(result.length).toBe(3);
	});

	it("filters out non-message roles", () => {
		const messages = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		] as unknown as AgentMessage[];
		const result = defaultConvertToLlm(messages);
		expect(result.length).toBe(1);
		expect(result[0].role).toBe("user");
	});

	it("filters out provider refusal assistant messages", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "normal response" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "blocked" }],
				stopReason: "error",
				stopDetails: { type: "refusal" },
			},
		] as unknown as AgentMessage[];
		const result = defaultConvertToLlm(messages);
		expect(result.length).toBe(1);
	});

	it("filters out provider sensitive assistant messages", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "blocked" }],
				stopReason: "error",
				stopDetails: { type: "sensitive" },
			},
		] as unknown as AgentMessage[];
		const result = defaultConvertToLlm(messages);
		expect(result.length).toBe(0);
	});

	it("keeps assistant messages with other stop reasons", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "response" }],
				stopReason: "stop",
				stopDetails: { type: "refusal" },
			},
		] as unknown as AgentMessage[];
		const result = defaultConvertToLlm(messages);
		expect(result.length).toBe(1);
	});

	it("returns empty for empty input", () => {
		expect(defaultConvertToLlm([])).toEqual([]);
	});
});

describe("ANTHROPIC_OUTPUT_BLOCKED_PREFIX", () => {
	it("is a non-empty string", () => {
		expect(ANTHROPIC_OUTPUT_BLOCKED_PREFIX.length).toBeGreaterThan(0);
	});

	it("starts with 'Output blocked'", () => {
		expect(ANTHROPIC_OUTPUT_BLOCKED_PREFIX).toContain("Output blocked");
	});
});

describe("isAnthropicOutputBlockedError", () => {
	it("returns true for message containing the prefix", () => {
		expect(isAnthropicOutputBlockedError("Output blocked by conten policy")).toBe(true);
	});

	it("returns true for message with prefix embedded", () => {
		expect(isAnthropicOutputBlockedError("Error: Output blocked by conten filter")).toBe(true);
	});

	it("returns false for unrelated message", () => {
		expect(isAnthropicOutputBlockedError("some other error")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isAnthropicOutputBlockedError("")).toBe(false);
	});

	it("returns false for similar but different message", () => {
		expect(isAnthropicOutputBlockedError("Output blocked by something else")).toBe(false);
	});
});

describe("refreshToolChoiceForActiveTools", () => {
	it("returns undefined for undefined toolChoice", () => {
		expect(refreshToolChoiceForActiveTools(undefined, [])).toBeUndefined();
	});

	it("returns string toolChoice unchanged", () => {
		expect(refreshToolChoiceForActiveTools("auto", [])).toBe("auto");
	});

	it("returns string toolChoice 'none' unchanged", () => {
		expect(refreshToolChoiceForActiveTools("none", [])).toBe("none");
	});

	it("returns string toolChoice 'required' unchanged", () => {
		expect(refreshToolChoiceForActiveTools("required", [])).toBe("required");
	});

	it("returns toolChoice when tool exists in tools", () => {
		const tools = [{ name: "myTool" }] as unknown as AgentTool[];
		const toolChoice: ToolChoice = { type: "tool", name: "myTool" };
		expect(refreshToolChoiceForActiveTools(toolChoice, tools)).toBe(toolChoice);
	});

	it("returns undefined when tool does not exist in tools", () => {
		const tools = [{ name: "otherTool" }] as unknown as AgentTool[];
		const toolChoice: ToolChoice = { type: "tool", name: "myTool" };
		expect(refreshToolChoiceForActiveTools(toolChoice, tools)).toBeUndefined();
	});

	it("returns undefined when tools is empty", () => {
		const toolChoice: ToolChoice = { type: "tool", name: "myTool" };
		expect(refreshToolChoiceForActiveTools(toolChoice, [])).toBeUndefined();
	});

	it("returns undefined when tools is default (empty)", () => {
		const toolChoice: ToolChoice = { type: "tool", name: "myTool" };
		expect(refreshToolChoiceForActiveTools(toolChoice)).toBeUndefined();
	});

	it("handles function-type toolChoice when tool exists", () => {
		const tools = [{ name: "myTool" }] as unknown as AgentTool[];
		const toolChoice = { type: "function", function: { name: "myTool" } } as unknown as ToolChoice;
		expect(refreshToolChoiceForActiveTools(toolChoice, tools)).toBe(toolChoice);
	});

	it("returns undefined for function-type toolChoice when tool missing", () => {
		const tools = [{ name: "otherTool" }] as unknown as AgentTool[];
		const toolChoice = { type: "function", function: { name: "myTool" } } as unknown as ToolChoice;
		expect(refreshToolChoiceForActiveTools(toolChoice, tools)).toBeUndefined();
	});
});
