import { beforeEach, describe, expect, it } from "bun:test";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { AgentPauseGate } from "../src/pause";
import { ThinkingLevel } from "../src/thinking";
import {
	__resetToolResultCapReportsForTests,
	capToolResultContent,
	DEFAULT_TOOL_RESULT_MAX_BYTES,
	elisionMarker,
} from "../src/tool-result-cap";
import { toolResultNeverRan } from "../src/tool-result-never-ran";

describe("AgentPauseGate", () => {
	it("starts unpaused", () => {
		const gate = new AgentPauseGate();
		expect(gate.paused).toBe(false);
		expect(gate.pausedAt).toBeUndefined();
	});

	it("pause sets paused state and returns true", () => {
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

	it("resume clears paused state and returns duration", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const duration = gate.resume();
		expect(typeof duration).toBe("number");
		expect(gate.paused).toBe(false);
		expect(gate.pausedAt).toBeUndefined();
	});

	it("resume returns undefined when not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.resume()).toBeUndefined();
	});

	it("waitUntilResumed resolves immediately when not paused", async () => {
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

	it("onChange listener receives pause transition", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(paused => events.push(paused));
		gate.pause();
		expect(events).toEqual([true]);
	});

	it("onChange listener receives resume transition", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(paused => events.push(paused));
		gate.pause();
		gate.resume();
		expect(events).toEqual([true, false]);
	});

	it("onChange unsubscribe stops notifications", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		const unsub = gate.onChange(paused => events.push(paused));
		unsub();
		gate.pause();
		expect(events).toEqual([]);
	});

	it("listener that throws does not break notification", () => {
		const gate = new AgentPauseGate();
		let called = false;
		gate.onChange(() => {
			throw new Error("listener error");
		});
		gate.onChange(() => {
			called = true;
		});
		gate.pause();
		expect(called).toBe(true);
	});

	it("waitUntilResumed throws on aborted signal when paused", async () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const controller = new AbortController();
		controller.abort();
		await expect(gate.waitUntilResumed(controller.signal)).rejects.toBeDefined();
	});

	it("waitUntilResumed throws on signal aborted after start", async () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const controller = new AbortController();
		const promise = gate.waitUntilResumed(controller.signal);
		controller.abort();
		await expect(promise).rejects.toBeDefined();
	});

	it("waitUntilResumed resolves when already aborted but not paused", async () => {
		const gate = new AgentPauseGate();
		const controller = new AbortController();
		controller.abort();
		await expect(gate.waitUntilResumed(controller.signal)).rejects.toBeDefined();
	});

	it("multiple listeners all receive transitions", () => {
		const gate = new AgentPauseGate();
		const e1: boolean[] = [];
		const e2: boolean[] = [];
		gate.onChange(p => e1.push(p));
		gate.onChange(p => e2.push(p));
		gate.pause();
		gate.resume();
		expect(e1).toEqual([true, false]);
		expect(e2).toEqual([true, false]);
	});

	it("pause/resume cycle works multiple times", () => {
		const gate = new AgentPauseGate();
		expect(gate.pause()).toBe(true);
		expect(gate.resume()).toBeGreaterThanOrEqual(0);
		expect(gate.pause()).toBe(true);
		expect(gate.resume()).toBeGreaterThanOrEqual(0);
		expect(gate.paused).toBe(false);
	});
});

describe("ThinkingLevel", () => {
	it("Inherit is 'inherit'", () => {
		expect(ThinkingLevel.Inherit).toBe("inherit");
	});

	it("Off is 'off'", () => {
		expect(ThinkingLevel.Off).toBe("off");
	});

	it("Minimal matches Effort.Minimal", () => {
		expect(ThinkingLevel.Minimal).toBe(Effort.Minimal);
	});

	it("Low matches Effort.Low", () => {
		expect(ThinkingLevel.Low).toBe(Effort.Low);
	});

	it("Medium matches Effort.Medium", () => {
		expect(ThinkingLevel.Medium).toBe(Effort.Medium);
	});

	it("High matches Effort.High", () => {
		expect(ThinkingLevel.High).toBe(Effort.High);
	});

	it("XHigh matches Effort.XHigh", () => {
		expect(ThinkingLevel.XHigh).toBe(Effort.XHigh);
	});

	it("Max matches Effort.Max", () => {
		expect(ThinkingLevel.Max).toBe(Effort.Max);
	});

	it("has exactly 8 levels", () => {
		expect(Object.keys(ThinkingLevel).length).toBe(8);
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
		expect(toolResultNeverRan(true)).toBe(false);
	});

	it("returns true for __synthetic=true and executed=false", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: false })).toBe(true);
	});

	it("returns false for __synthetic=true and executed=true", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: true })).toBe(false);
	});

	it("returns false for __synthetic=false and executed=false", () => {
		expect(toolResultNeverRan({ __synthetic: false, executed: false })).toBe(false);
	});

	it("returns true for __skipped=true with entered not true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: false })).toBe(true);
	});

	it("returns true for __skipped=true without entered", () => {
		expect(toolResultNeverRan({ __skipped: true })).toBe(true);
	});

	it("returns false for __skipped=true and entered=true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: true })).toBe(false);
	});

	it("returns false for __skipped=false", () => {
		expect(toolResultNeverRan({ __skipped: false })).toBe(false);
	});

	it("returns false for empty object", () => {
		expect(toolResultNeverRan({})).toBe(false);
	});

	it("returns false for object without synthetic/skipped fields", () => {
		expect(toolResultNeverRan({ foo: "bar" })).toBe(false);
	});

	it("__skipped takes precedence over __synthetic", () => {
		expect(toolResultNeverRan({ __skipped: true, __synthetic: true, executed: false, entered: false })).toBe(true);
	});
});

describe("capToolResultContent", () => {
	beforeEach(() => __resetToolResultCapReportsForTests());

	it("returns content unchanged when under max", () => {
		const content: TextContent[] = [{ type: "text", text: "hello" }];
		const result = capToolResultContent(content, "test_tool");
		expect(result.content).toBe(content);
		expect(result.originalBytes).toBe(5);
		expect(result.elidedBytes).toBe(0);
	});

	it("returns content unchanged when maxBytes is 0", () => {
		const content: TextContent[] = [{ type: "text", text: "hello" }];
		const result = capToolResultContent(content, "test_tool", 0);
		expect(result.content).toBe(content);
		expect(result.elidedBytes).toBe(0);
	});

	it("returns content unchanged when maxBytes is negative", () => {
		const content: TextContent[] = [{ type: "text", text: "hello" }];
		const result = capToolResultContent(content, "test_tool", -1);
		expect(result.content).toBe(content);
		expect(result.elidedBytes).toBe(0);
	});

	it("caps text content when over max", () => {
		const longText = "x".repeat(2048);
		const content: TextContent[] = [{ type: "text", text: longText }];
		const result = capToolResultContent(content, "test_tool", 512);
		expect(result.originalBytes).toBe(2048);
		expect(result.elidedBytes).toBeGreaterThan(0);
		const cappedText = (result.content[0] as TextContent).text;
		expect(Buffer.byteLength(cappedText, "utf-8")).toBeLessThan(2048);
	});

	it("preserves image content blocks", () => {
		const imageBlock = {
			type: "image",
			media_type: "image/png",
			data: "base64data",
		} as unknown as ImageContent;
		const content = [{ type: "text", text: "x".repeat(2048) } as TextContent, imageBlock];
		const result = capToolResultContent(content, "test_tool", 512);
		const imageResult = result.content.find(b => b.type === "image");
		expect(imageResult).toBe(imageBlock);
	});

	it("handles multiple text blocks with proportional capping", () => {
		const content: TextContent[] = [
			{ type: "text", text: "a".repeat(1000) },
			{ type: "text", text: "b".repeat(1000) },
		];
		const result = capToolResultContent(content, "test_tool", 500);
		expect(result.originalBytes).toBe(2000);
		expect(result.elidedBytes).toBeGreaterThan(0);
	});

	it("DEFAULT_TOOL_RESULT_MAX_BYTES is 1 MiB", () => {
		expect(DEFAULT_TOOL_RESULT_MAX_BYTES).toBe(1024 * 1024);
	});

	it("elisionMarker is a function", () => {
		expect(typeof elisionMarker).toBe("function");
		expect(elisionMarker(100)).toBeDefined();
	});

	it("handles empty content array", () => {
		const result = capToolResultContent([], "test_tool");
		expect(result.content).toEqual([]);
		expect(result.originalBytes).toBe(0);
		expect(result.elidedBytes).toBe(0);
	});

	it("handles text with multi-byte characters", () => {
		const content: TextContent[] = [{ type: "text", text: "你".repeat(500) }];
		const result = capToolResultContent(content, "test_tool", 256);
		expect(result.originalBytes).toBe(1500);
		expect(result.elidedBytes).toBeGreaterThan(0);
	});

	it("does not cap when original equals max exactly", () => {
		const text = "x".repeat(100);
		const content: TextContent[] = [{ type: "text", text }];
		const result = capToolResultContent(content, "test_tool", 100);
		expect(result.elidedBytes).toBe(0);
		expect(result.content).toBe(content);
	});
});
