import { describe, expect, it } from "bun:test";
import type { Model } from "../src/types";
import {
	detectHarmonyLeak,
	type HarmonySignal,
	isHarmonyLeakMitigationTarget,
	signalListLabel,
} from "../src/utils/harmony-leak";

function model(provider: string): Model {
	return { provider, id: "test", api: "openai-completions" } as unknown as Model;
}

describe("isHarmonyLeakMitigationTarget", () => {
	it("returns true for openai-codex provider", () => {
		expect(isHarmonyLeakMitigationTarget(model("openai-codex"))).toBe(true);
	});
	it("returns false for openai provider", () => {
		expect(isHarmonyLeakMitigationTarget(model("openai"))).toBe(false);
	});
	it("returns false for anthropic provider", () => {
		expect(isHarmonyLeakMitigationTarget(model("anthropic"))).toBe(false);
	});
	it("returns false for google provider", () => {
		expect(isHarmonyLeakMitigationTarget(model("google"))).toBe(false);
	});
});

describe("signalListLabel", () => {
	it("returns 'none' for empty signals", () => {
		expect(signalListLabel([])).toBe("none");
	});
	it("returns single class label", () => {
		const signals: HarmonySignal[] = [{ classes: ["H"], start: 0, end: 5, text: "<|x|>" }];
		expect(signalListLabel(signals)).toBe("H");
	});
	it("returns joined labels for multiple signals", () => {
		const signals: HarmonySignal[] = [
			{ classes: ["H"], start: 0, end: 5, text: "<|x|>" },
			{ classes: ["M", "C"], start: 10, end: 20, text: "to=functions.x" },
		];
		expect(signalListLabel(signals)).toBe("H,M+C");
	});
	it("deduplicates identical class labels", () => {
		const signals: HarmonySignal[] = [
			{ classes: ["H"], start: 0, end: 5, text: "<|x|>" },
			{ classes: ["H"], start: 10, end: 15, text: "<|y|>" },
		];
		expect(signalListLabel(signals)).toBe("H");
	});
	it("preserves order of first occurrence", () => {
		const signals: HarmonySignal[] = [
			{ classes: ["M", "C"], start: 0, end: 5, text: "a" },
			{ classes: ["H"], start: 10, end: 15, text: "b" },
			{ classes: ["M", "C"], start: 20, end: 25, text: "c" },
		];
		expect(signalListLabel(signals)).toBe("M+C,H");
	});
});

describe("detectHarmonyLeak", () => {
	it("returns undefined for clean text", () => {
		expect(detectHarmonyLeak("hello world", "assistant_text")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(detectHarmonyLeak("", "assistant_text")).toBeUndefined();
	});
	it("detects harmony markers in assistant text", () => {
		const result = detectHarmonyLeak("some text <|start|> more text", "assistant_text");
		expect(result).toBeDefined();
		expect(result?.surface).toBe("assistant_text");
		expect(result?.signals.length).toBeGreaterThan(0);
		expect(result?.signals[0].classes).toContain("H");
	});
	it("detects harmony markers in thinking", () => {
		const result = detectHarmonyLeak("<|end|>", "assistant_thinking");
		expect(result).toBeDefined();
		expect(result?.surface).toBe("assistant_thinking");
	});
	it("detects to=functions marker with channel word", () => {
		const result = detectHarmonyLeak("assistant to=functions.foo bar", "assistant_text");
		expect(result).toBeDefined();
		expect(result?.signals.some(s => s.classes.includes("C"))).toBe(true);
	});
	it("detects to=functions marker with glitch", () => {
		const result = detectHarmonyLeak("to=functions.foo changedFiles bar", "assistant_text");
		expect(result).toBeDefined();
		expect(result?.signals.some(s => s.classes.includes("G"))).toBe(true);
	});
	it("does not detect markers inside code fences", () => {
		const text = "```\n<|start|>\n```";
		expect(detectHarmonyLeak(text, "assistant_text")).toBeUndefined();
	});
	it("returns undefined for tool_arg without trailing signal", () => {
		expect(detectHarmonyLeak("to=functions.foo", "tool_arg")).toBeUndefined();
	});
	it("returns detection for tool_arg with trailing signal", () => {
		const result = detectHarmonyLeak("to=functions.foo trailing", "tool_arg", { parsedEnd: 0 });
		expect(result).toBeDefined();
	});
	it("passes through contentIndex and toolName", () => {
		const result = detectHarmonyLeak("<|start|>", "assistant_text", {
			contentIndex: 3,
			toolName: "read",
			toolCallId: "call-1",
		});
		expect(result?.contentIndex).toBe(3);
		expect(result?.toolName).toBe("read");
		expect(result?.toolCallId).toBe("call-1");
	});
	it("sorts signals by start position", () => {
		const result = detectHarmonyLeak("<|end|> <|start|>", "assistant_text");
		expect(result).toBeDefined();
		expect(result?.signals[0].start).toBeLessThanOrEqual(result?.signals[1].start ?? 0);
	});
});
