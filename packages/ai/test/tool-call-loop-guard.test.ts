import { describe, expect, test } from "bun:test";
import { INTENT_FIELD } from "@veyyon/wire";
import type { AssistantMessage } from "../src/types";
import { ToolCallLoopGuard } from "../src/utils/tool-call-loop-guard";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("ToolCallLoopGuard", () => {
	test("detects the fifth consecutive identical tool call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: ["job", "irc"] });
		let detection = null;
		for (let index = 0; index < 5; index++) {
			const toolCallId = `call-${index}`;
			detection = guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q", timeout: 120 } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}

		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "1263 passed, 4 skipped",
			argumentsSummary: '{"command":"pytest -q","timeout":120}',
		});
	});

	test("canonicalizes argument key order and ignores harness intent fields", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "first", name: "read", arguments: { path: "a.ts", [INTENT_FIELD]: "first" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "second",
							name: "read",
							arguments: { [INTENT_FIELD]: "second", path: "a.ts" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toMatchObject({ toolName: "read", count: 2 });
	});

	test("resets the consecutive count on a different call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/index.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "third", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "third",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	// A model-supplied `__proto__` argument key used to be dropped by the
	// canonicalizer's bare `output[key] = value`, so every distinct `__proto__`
	// argument set collapsed to the same empty canonical form and hash. That is
	// two bugs at once: unrelated calls collide (false loop detection) and the
	// argument summary loses the key. These pin the prototype-safe canonicalization.
	// Build args with a REAL own, enumerable `__proto__` data property, exactly as
	// the dialect parsers now produce (via setSafeProperty). An object LITERAL
	// `{ __proto__: v }` would instead use the prototype-setter syntax and create no
	// such own key, so it cannot stand in for parsed model output here.
	function argsWithProto(value: unknown): Record<string, unknown> {
		const args: Record<string, unknown> = {};
		Object.defineProperty(args, "__proto__", { value, writable: true, enumerable: true, configurable: true });
		return args;
	}

	function turn(id: string, args: Record<string, unknown>) {
		return {
			message: {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id, name: "read", arguments: args }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult" as const,
					toolCallId: id,
					toolName: "read",
					content: [{ type: "text" as const, text: "done" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
	}

	test("does not collide two distinct __proto__ argument sets into a false repeat", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		// Both calls carry ONLY a `__proto__` key with different values. Pre-fix both
		// canonicalized to `{}` and the second would falsely trip the threshold.
		expect(guard.recordTurn(turn("a", argsWithProto("x")))).toBeNull();
		expect(guard.recordTurn(turn("b", argsWithProto("y")))).toBeNull();
		// A __proto__-only call must also not collide with a genuinely empty-args call.
		expect(guard.recordTurn(turn("c", {}))).toBeNull();
	});

	test("detects a real __proto__-keyed repeat and keeps the key in the argument summary", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn("a", argsWithProto("x")))).toBeNull();
		const detection = guard.recordTurn(turn("b", argsWithProto("x")));
		// Pre-fix the summary would be "{}" because the key was dropped.
		expect(detection).toMatchObject({
			toolName: "read",
			count: 2,
			argumentsSummary: '{"__proto__":"x"}',
		});
	});

	test("ignores exempt polling tools", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["job"] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});
	test("detects consecutive subsumed read calls on unchanged files at threshold of 2", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// 1. Initial read of file range 1-200
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/segments.ts:1-200" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-1",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n1: line 1\n200: line 200\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 2. Subsumed read #1 (lines 50-100 are within 1-200) -> count = 1
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/segments.ts:50-100" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-2",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n50: line 50\n100: line 100\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 3. Subsumed read #2 (lines 80-120 are within 1-200) -> count = 2 -> TRIGGERS!
		const detection = guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "src/segments.ts:80-120" } }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "read-3",
					toolName: "read",
					content: [{ type: "text", text: "[src/segments.ts#1A2B]\n80: line 80\n120: line 120\n" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		expect(detection).not.toBeNull();
		expect(detection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
			resultSummary: "Requested lines are already present in previous turn context",
		});

		// 4. Still subsumed, but the steer already went out. A redirect repeated on
		// every further read is noise the model pays for on each request.
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-4", name: "read", arguments: { path: "src/segments.ts:85-115" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-4",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n85: line 85\n115: line 115\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("allows legitimate overlapping context expansion without triggering loop guard", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// 1. Initial read 1-50
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/segments.ts:1-50" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-1",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n1: line 1\n50: line 50\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 2. Overlapping scroll: reads 40-100 (adds new lines 51-100) -> NOT subsumed!
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/segments.ts:40-100" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-2",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n40: line 40\n100: line 100\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 3. Overlapping scroll: reads 90-150 (adds new lines 101-150) -> NOT subsumed!
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "src/segments.ts:90-150" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-3",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n90: line 90\n150: line 150\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("allows summary drill-down without triggering loop guard", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// 1. Initial whole-file read of a large file (> 200 chars, summary declarations at top)
		const summaryText =
			"[src/segments.ts#1A2B]\n" +
			"1: export class SegmentController {\n" +
			"2:   init() { … }\n" +
			"3:   process() { … }\n" +
			"4:   validate() { … }\n" +
			"5:   transform() { … }\n" +
			"6:   render() { … }\n" +
			"7:   cleanup() { … }\n" +
			"8:   destroy() { … }\n" +
			"}\n" +
			"// 250 declarations omitted. Re-issue with range selector.\n";

		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/segments.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-1",
						toolName: "read",
						content: [{ type: "text", text: summaryText }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 2. First range read (lines 140-240) -> must NOT be subsumed by whole-file summary
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/segments.ts:140-240" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-2",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n140: function a() {\n240: }\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 3. Second range read (lines 250-350) -> must NOT be subsumed or blocked
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "src/segments.ts:250-350" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-3",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n250: function b() {\n350: }\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});
	test("two distinct line ranges of the same file do not subsume each other", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/segments.ts:1-50" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "r1",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n1: a\n50: b\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/segments.ts:100-150" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "r2",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n100: c\n150: d\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "r3", name: "read", arguments: { path: "src/segments.ts:200-250" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "r3",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\n200: e\n250: f\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("detects exact repeat of selector-free read after previous selector-free read", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// 1. Initial read
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/segments.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "r1",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\nsome file content\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 2. Subsumed read #1 of exact same selector-free target -> count = 1
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/segments.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "r2",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#1A2B]\nsome file content\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 3. Subsumed read #2 of exact same selector-free target -> count = 2 -> TRIGGERS!
		const detection = guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "r3", name: "read", arguments: { path: "src/segments.ts" } }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "r3",
					toolName: "read",
					content: [{ type: "text", text: "[src/segments.ts#1A2B]\nsome file content\n" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		expect(detection).not.toBeNull();
		expect(detection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
		});
	});

	test("resets read history on mutating tools like edit or write", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// 1. Initial read 1-200
		guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/segments.ts:1-200" } }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content: [{ type: "text", text: "[src/segments.ts#1A2B]\n1: line 1\n200: line 200\n" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		// 2. Subsumed read #1 -> count = 1
		guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/segments.ts:50-100" } }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "read-2",
					toolName: "read",
					content: [{ type: "text", text: "[src/segments.ts#1A2B]\n50: line 50\n100: line 100\n" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		// 3. Edit tool runs on the file! -> resets read history
		guard.recordTurn({
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: { input: "[src/segments.ts#1A2B]\nSWAP 50.=50:\n+new line" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [{ type: "text", text: "applied edit" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		// 4. Fresh read after edit -> NOT subsumed because edit reset the history!
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "src/segments.ts:50-100" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "read-3",
						toolName: "read",
						content: [{ type: "text", text: "[src/segments.ts#9F2C]\n50: new line\n100: line 100\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("detects exact repeat of identical ranged read via generic argument hash detector", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });

		// 1. Initial ranged read of lines 50-200
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/foo.ts:50-200" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "r1",
						toolName: "read",
						content: [{ type: "text", text: "[src/foo.ts#1A2B]\n50: line 50\n200: line 200\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 2. Exact same ranged read in the next turn -> caught by generic argument hash detector
		const detection = guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/foo.ts:50-200" } }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "r2",
					toolName: "read",
					content: [{ type: "text", text: "[src/foo.ts#1A2B]\n50: line 50\n200: line 200\n" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		expect(detection).not.toBeNull();
		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
			resultSummary: "[src/foo.ts#1A2B] 50: line 50 200: line 200",
			argumentsSummary: '{"path":"src/foo.ts:50-200"}',
		});
	});
});
