/**
 * The runtime half of the vocabulary agrees with its type half.
 *
 * WHY THIS SUITE EXISTS. Every ladder in this package (`THINKING_EFFORTS`, `SERVICE_TIERS`,
 * `INSTRUMENTATION_LEVELS`, `THINKING_CONTROL_MODES`, `OPENAI_REASONING_DISABLE_MODES`) is a
 * value so a provider or host can enumerate it at run time, and the guard beside a ladder reads
 * that ladder rather than spelling its members again. Before the guards were one owner, two
 * OpenAI-compatible servers each kept a hand-written chain of comparisons, and a level added to
 * the ladder was rejected by both. This suite pins each ladder in declaration order and proves
 * each guard accepts every member and nothing else, including a prototype key and the empty
 * string, so a member added to a ladder without a recorded decision turns the suite red.
 *
 * WHAT IT DOES NOT CATCH. A member added to a string-literal union with no runtime ladder
 * (`ToolCallStatus`, `StopReason`) is a compile-time change with no runtime witness.
 */
import { describe, expect, it } from "bun:test";
import {
	canonicalizeEfforts,
	Effort,
	INSTRUMENTATION_LEVELS,
	isEffort,
	isServiceTier,
	OPENAI_REASONING_DISABLE_MODES,
	OPENAI_WIRE_TIERS,
	SERVICE_TIERS,
	THINKING_CONTROL_MODES,
	THINKING_EFFORTS,
} from "../src/index";

describe("a ladder is listed once and its guard reads that list", () => {
	it("lists the six efforts least to most intensive", () => {
		expect([...THINKING_EFFORTS]).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(THINKING_EFFORTS.map(String)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("recognises every effort and nothing else", () => {
		for (const effort of THINKING_EFFORTS) expect(isEffort(effort)).toBe(true);
		expect(isEffort("ultra")).toBe(false);
		expect(isEffort("")).toBe(false);
		expect(isEffort("toString")).toBe(false);
		expect(isEffort(3)).toBe(false);
	});

	it("canonicalizes an out-of-order ladder with duplicates to declaration order", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.Low, Effort.High])).toEqual([Effort.Low, Effort.High]);
		expect(canonicalizeEfforts([])).toEqual([]);
	});

	it("lists the five service tiers and the three OpenAI wire tiers", () => {
		expect([...SERVICE_TIERS]).toEqual(["auto", "default", "flex", "scale", "priority"]);
		expect([...OPENAI_WIRE_TIERS]).toEqual(["flex", "scale", "priority"]);
	});

	it("recognises every service tier and nothing else", () => {
		for (const tier of SERVICE_TIERS) expect(isServiceTier(tier)).toBe(true);
		expect(isServiceTier("standard")).toBe(false);
		expect(isServiceTier("")).toBe(false);
		expect(isServiceTier("toString")).toBe(false);
		expect(isServiceTier(undefined)).toBe(false);
	});

	it("lists the instrumentation levels, thinking transports and reasoning disable modes", () => {
		expect([...INSTRUMENTATION_LEVELS]).toEqual(["off", "basic", "rich", "ultra"]);
		expect([...THINKING_CONTROL_MODES]).toEqual([
			"effort",
			"budget",
			"google-level",
			"anthropic-adaptive",
			"anthropic-budget-effort",
		]);
		expect([...OPENAI_REASONING_DISABLE_MODES]).toEqual([
			"omit",
			"lowest-effort",
			"openrouter-enabled-false",
			"zai-thinking-disabled",
			"qwen-enable-thinking-false",
			"qwen-template-false",
		]);
	});
});
