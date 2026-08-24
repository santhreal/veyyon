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

		// 1. Initial read returns structural summary with elision markers
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
						content: [
							{
								type: "text",
								text: "structural summary\n1: export function a() { … }\nre-issue ONLY the ranges you need",
							},
						],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();

		// 2. Drill-down into lines 140-240 -> NOT subsumed because summary hid the interior!
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
});
