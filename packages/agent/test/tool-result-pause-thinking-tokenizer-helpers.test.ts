import { beforeEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";
import { ThinkingLevel } from "../src/thinking";
import { countTokens } from "../src/tokenizer";
import {
	__resetToolResultCapReportsForTests,
	capToolResultContent,
	DEFAULT_TOOL_RESULT_MAX_BYTES,
} from "../src/tool-result-cap";
import { toolResultNeverRan } from "../src/tool-result-never-ran";

describe("DEFAULT_TOOL_RESULT_MAX_BYTES", () => {
	it("is 1 MiB", () => {
		expect(DEFAULT_TOOL_RESULT_MAX_BYTES).toBe(1024 * 1024);
	});
});

describe("capToolResultContent", () => {
	beforeEach(() => {
		__resetToolResultCapReportsForTests();
	});

	it("returns content unchanged when under limit", () => {
		const content = [{ type: "text" as const, text: "hello" }];
		const result = capToolResultContent(content, "test-tool", 1024);
		expect(result.content).toBe(content);
		expect(result.elidedBytes).toBe(0);
	});

	it("returns content unchanged when maxBytes is 0", () => {
		const content = [{ type: "text" as const, text: "hello" }];
		const result = capToolResultContent(content, "test-tool", 0);
		expect(result.content).toBe(content);
	});

	it("returns content unchanged when maxBytes is negative", () => {
		const content = [{ type: "text" as const, text: "hello" }];
		const result = capToolResultContent(content, "test-tool", -1);
		expect(result.content).toBe(content);
	});

	it("caps content when over limit", () => {
		const longText = "x".repeat(2000);
		const content = [{ type: "text" as const, text: longText }];
		const result = capToolResultContent(content, "test-tool", 100);
		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(result.originalBytes).toBe(2000);
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeLessThan(longText.length);
	});

	it("preserves non-text blocks", () => {
		const imageBlock = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png", data: "abc" },
		};
		const content = [
			{ type: "text" as const, text: "x".repeat(2000) },
			imageBlock,
		] as unknown as Parameters<typeof capToolResultContent>[0];
		const result = capToolResultContent(content, "test-tool", 100);
		expect(result.content[1] as unknown).toBe(imageBlock);
	});

	it("handles multiple text blocks", () => {
		const content = [
			{ type: "text" as const, text: "a".repeat(500) },
			{ type: "text" as const, text: "b".repeat(500) },
		];
		const result = capToolResultContent(content, "test-tool", 100);
		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(result.content).toHaveLength(2);
	});

	it("handles empty content array", () => {
		const result = capToolResultContent([], "test-tool", 100);
		expect(result.content).toEqual([]);
		expect(result.elidedBytes).toBe(0);
	});

	it("reports originalBytes correctly", () => {
		const content = [{ type: "text" as const, text: "hello world" }];
		const result = capToolResultContent(content, "test-tool", 1024);
		expect(result.originalBytes).toBe(Buffer.byteLength("hello world", "utf-8"));
	});
});

describe("toolResultNeverRan", () => {
	it("returns false for null", () => {
		expect(toolResultNeverRan(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(toolResultNeverRan(undefined)).toBe(false);
	});

	it("returns false for non-object", () => {
		expect(toolResultNeverRan("string")).toBe(false);
		expect(toolResultNeverRan(42)).toBe(false);
	});

	it("returns true for __skipped with entered not true", () => {
		expect(toolResultNeverRan({ __skipped: true })).toBe(true);
	});

	it("returns false for __skipped with entered true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: true })).toBe(false);
	});

	it("returns true for __synthetic and not executed", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: false })).toBe(true);
	});

	it("returns false for __synthetic and executed", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: true })).toBe(false);
	});

	it("returns false for plain object", () => {
		expect(toolResultNeverRan({})).toBe(false);
	});

	it("returns false for __skipped false", () => {
		expect(toolResultNeverRan({ __skipped: false })).toBe(false);
	});
});

describe("AgentPauseGate", () => {
	it("starts not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.paused).toBe(false);
		expect(gate.pausedAt).toBeUndefined();
	});

	it("pause sets paused to true", () => {
		const gate = new AgentPauseGate();
		expect(gate.pause()).toBe(true);
		expect(gate.paused).toBe(true);
		expect(gate.pausedAt).toBeDefined();
	});

	it("pause returns false when already paused", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		expect(gate.pause()).toBe(false);
	});

	it("resume sets paused to false", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const duration = gate.resume();
		expect(gate.paused).toBe(false);
		expect(typeof duration).toBe("number");
	});

	it("resume returns undefined when not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.resume()).toBeUndefined();
	});

	it("onChange listener receives pause events", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(paused => events.push(paused));
		gate.pause();
		gate.resume();
		expect(events).toEqual([true, false]);
	});

	it("onChange returns unsubscribe function", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		const unsub = gate.onChange(paused => events.push(paused));
		unsub();
		gate.pause();
		gate.resume();
		expect(events).toEqual([]);
	});

	it("waitUntilResumed resolves when not paused", async () => {
		const gate = new AgentPauseGate();
		await gate.waitUntilResumed();
	});

	it("waitUntilResumed resolves after resume", async () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const promise = gate.waitUntilResumed();
		gate.resume();
		await promise;
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
		expect(ThinkingLevel.Minimal).toBeDefined();
	});

	it("has Low value", () => {
		expect(ThinkingLevel.Low).toBeDefined();
	});

	it("has Medium value", () => {
		expect(ThinkingLevel.Medium).toBeDefined();
	});

	it("has High value", () => {
		expect(ThinkingLevel.High).toBeDefined();
	});

	it("has XHigh value", () => {
		expect(ThinkingLevel.XHigh).toBeDefined();
	});

	it("has Max value", () => {
		expect(ThinkingLevel.Max).toBeDefined();
	});
});

describe("countTokens", () => {
	it("returns positive number for string", () => {
		const result = countTokens("hello world");
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});

	it("returns positive number for array of strings", () => {
		const result = countTokens(["hello", "world"]);
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});

	it("returns 0 for empty string", () => {
		expect(countTokens("")).toBe(0);
	});

	it("returns 0 for empty array", () => {
		expect(countTokens([])).toBe(0);
	});

	it("handles single word", () => {
		const result = countTokens("hello");
		expect(result).toBeGreaterThan(0);
	});

	it("handles long text", () => {
		const result = countTokens("x".repeat(1000));
		expect(result).toBeGreaterThan(0);
	});

	it("array sum is consistent with individual calls", () => {
		const a = countTokens("hello");
		const b = countTokens("world");
		const sum = countTokens(["hello", "world"]);
		expect(sum).toBe(a + b);
	});
});
