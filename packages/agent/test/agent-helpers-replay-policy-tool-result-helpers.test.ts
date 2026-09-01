import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_OUTPUT_BLOCKED_PREFIX,
	defaultConvertToLlm,
	isAnthropicOutputBlockedError,
	refreshToolChoiceForActiveTools,
} from "../src/agent-helpers";
import { filterProviderReplayMessages, isProviderRefusalMessage } from "../src/replay-policy";
import { ThinkingLevel } from "../src/thinking";
import { toolResultNeverRan } from "../src/tool-result-never-ran";

describe("isAnthropicOutputBlockedError", () => {
	it("returns true for blocked output message", () => {
		expect(isAnthropicOutputBlockedError("Output blocked by conten policy")).toBe(true);
	});
	it("returns true for blocked output in longer message", () => {
		expect(isAnthropicOutputBlockedError("Error: Output blocked by content filter")).toBe(true);
	});
	it("returns false for unrelated message", () => {
		expect(isAnthropicOutputBlockedError("some other error")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isAnthropicOutputBlockedError("")).toBe(false);
	});
});

describe("ANTHROPIC_OUTPUT_BLOCKED_PREFIX", () => {
	it("is the expected prefix", () => {
		expect(ANTHROPIC_OUTPUT_BLOCKED_PREFIX).toBe("Output blocked by conten");
	});
});

describe("defaultConvertToLlm", () => {
	it("filters user and toolResult messages", () => {
		const messages = [
			{ role: "user", content: "hello", timestamp: 0 },
			{ role: "toolResult", toolCallId: "1", toolName: "test", content: [], isError: false, timestamp: 0 },
		];
		const result = defaultConvertToLlm(messages as never);
		expect(result).toHaveLength(2);
	});
	it("filters out non-user/toolResult/assistant messages", () => {
		const messages = [
			{ role: "developer", content: "sys", timestamp: 0 },
			{ role: "user", content: "hello", timestamp: 0 },
		];
		const result = defaultConvertToLlm(messages as never);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});
	it("filters out provider refusal assistant messages", () => {
		const messages = [
			{
				role: "assistant",
				content: [],
				model: "x",
				provider: "y",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "error",
				stopDetails: { type: "refusal" },
				timestamp: 0,
			},
			{ role: "user", content: "hello", timestamp: 0 },
		];
		const result = defaultConvertToLlm(messages as never);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});
	it("keeps non-refusal assistant messages", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				model: "x",
				provider: "y",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: 0,
			},
		];
		const result = defaultConvertToLlm(messages as never);
		expect(result).toHaveLength(1);
	});
});

describe("refreshToolChoiceForActiveTools", () => {
	it("returns undefined for undefined toolChoice", () => {
		expect(refreshToolChoiceForActiveTools(undefined, [])).toBeUndefined();
	});
	it("returns string toolChoice as-is", () => {
		expect(refreshToolChoiceForActiveTools("auto", [])).toBe("auto");
	});
	it("returns toolChoice when tool exists", () => {
		const toolChoice = { type: "tool", name: "myTool" } as never;
		const tools = [{ name: "myTool" }] as never;
		expect(refreshToolChoiceForActiveTools(toolChoice, tools)).toBe(toolChoice);
	});
	it("returns undefined when tool does not exist", () => {
		const toolChoice = { type: "tool", name: "myTool" } as never;
		const tools = [{ name: "otherTool" }] as never;
		expect(refreshToolChoiceForActiveTools(toolChoice, tools)).toBeUndefined();
	});
	it("handles empty tools array", () => {
		const toolChoice = { type: "tool", name: "myTool" } as never;
		expect(refreshToolChoiceForActiveTools(toolChoice, [])).toBeUndefined();
	});
	it("handles default tools parameter", () => {
		expect(refreshToolChoiceForActiveTools("auto")).toBe("auto");
	});
});

describe("isProviderRefusalMessage", () => {
	it("returns true for refusal stop type", () => {
		const msg = { role: "assistant", stopReason: "error", stopDetails: { type: "refusal" } } as never;
		expect(isProviderRefusalMessage(msg)).toBe(true);
	});
	it("returns true for sensitive stop type", () => {
		const msg = { role: "assistant", stopReason: "error", stopDetails: { type: "sensitive" } } as never;
		expect(isProviderRefusalMessage(msg)).toBe(true);
	});
	it("returns false for non-error stop reason", () => {
		const msg = { role: "assistant", stopReason: "stop", stopDetails: { type: "refusal" } } as never;
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns false for other stop type", () => {
		const msg = { role: "assistant", stopReason: "error", stopDetails: { type: "other" } } as never;
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns false for undefined stopDetails", () => {
		const msg = { role: "assistant", stopReason: "error" } as never;
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
});

describe("filterProviderReplayMessages", () => {
	it("filters out refusal messages", () => {
		const messages = [
			{ role: "assistant", stopReason: "error", stopDetails: { type: "refusal" } },
			{ role: "user", content: "hello" },
		] as never;
		const result = filterProviderReplayMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});
	it("keeps non-refusal messages", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", stopReason: "stop" },
		] as never;
		const result = filterProviderReplayMessages(messages);
		expect(result).toHaveLength(2);
	});
	it("handles empty array", () => {
		expect(filterProviderReplayMessages([])).toEqual([]);
	});
});

describe("toolResultNeverRan", () => {
	it("returns true for __skipped with entered not true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: false })).toBe(true);
	});
	it("returns false for __skipped with entered true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: true })).toBe(false);
	});
	it("returns true for __synthetic with executed false", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: false })).toBe(true);
	});
	it("returns false for __synthetic with executed true", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: true })).toBe(false);
	});
	it("returns false for null", () => {
		expect(toolResultNeverRan(null)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(toolResultNeverRan(undefined)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(toolResultNeverRan("string")).toBe(false);
	});
	it("returns false for object without markers", () => {
		expect(toolResultNeverRan({ foo: "bar" })).toBe(false);
	});
});

describe("ThinkingLevel", () => {
	it("has Inherit value", () => {
		expect(ThinkingLevel.Inherit).toBe("inherit");
	});
	it("has Off value", () => {
		expect(ThinkingLevel.Off).toBe("off");
	});
	it("has Minimal value", () => {
		expect(ThinkingLevel.Minimal).toBe("minimal");
	});
	it("has Max value", () => {
		expect(ThinkingLevel.Max).toBe("max");
	});
	it("has 8 levels", () => {
		expect(Object.keys(ThinkingLevel)).toHaveLength(8);
	});
});
