/**
 * WHY THIS SUITE EXISTS.
 *
 * Models operating in autonomous loops occasionally enter redundant exploration traps:
 * requesting line ranges of files that were already completely read in earlier turns and
 * remain unchanged in the prompt context. To halt these runaway loops without breaking
 * legitimate progressive scrolling, multi-target reads, or re-reads of modified files,
 * `ToolCallLoopGuard` detects consecutive fully-subsumed `read` operations and issues a
 * targeted steering notice once at the configured threshold while preserving the prompt
 * cache prefix.
 *
 * THE CLASS THIS CLOSES.
 * 1. Fully-subsumed repeat reads on unchanged files trigger steering at the threshold.
 * 2. Partially-overlapping reads (such as progressive scrolling or drill-downs) are never
 *    falsely classified as redundant.
 * 3. File modifications (indicated by a changed snapshot tag or intermediate mutating
 *    tool calls like edit, write, ast_edit, patch, or bash) invalidate read history so
 *    re-reads of modified files proceed without false steering.
 * 4. Multi-target reads (`path1;path2`) where only a subset of targets is subsumed do not
 *    trip the guard until all targets in consecutive calls are subsumed.
 * 5. The `readSubsumptionThreshold` option boundary behaves deterministically: defaulting
 *    to 2 and altering observable steering timing when set to 1 or higher.
 * 6. The prompt-cache prefix is preserved: turns and messages are never mutated in place,
 *    and steering fires exactly once at the threshold rather than repeatedly mutating turns.
 *
 * WHAT IT DOES NOT CATCH.
 * It does not execute the underlying filesystem tool handlers or generate LLM completions;
 * it isolates the cross-turn tracking, subsumption analysis, and loop detection invariants.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "../src/types";
import { ToolCallLoopGuard, type ToolCallLoopTurn } from "../src/utils/tool-call-loop-guard";

const zeroUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeReadTurn(
	id: string,
	pathArg: string,
	resultText = "[src/file.ts#1A2B]\n1: line 1\n100: line 100\n",
): ToolCallLoopTurn {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: "read",
				arguments: { path: pathArg },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: 1000,
	};

	const toolResults: ToolResultMessage[] = [
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: resultText }],
			isError: false,
			timestamp: 1001,
		},
	];

	return { message, toolResults };
}

function makeMutatingTurn(
	id: string,
	toolName: "edit" | "write" | "ast_edit" | "patch" | "bash",
	args: Record<string, unknown>,
): ToolCallLoopTurn {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: toolName,
				arguments: args,
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: 2000,
	};

	const toolResults: ToolResultMessage[] = [
		{
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2001,
		},
	];

	return { message, toolResults };
}

describe("ToolCallLoopGuard read subsumption detection", () => {
	it("fires the loop guard on consecutive fully-subsumed repeat reads of unchanged files", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Baseline: initial wide read (lines 1-200)
		expect(guard.recordTurn(makeReadTurn("turn-0", "src/core.ts:1-200"))).toBeNull();

		// 1st subsumed read (lines 50-100 are within 1-200) -> count = 1
		expect(guard.recordTurn(makeReadTurn("turn-1", "src/core.ts:50-100"))).toBeNull();

		// 2nd consecutive subsumed read (lines 80-120 are within 1-200) -> count = 2 -> threshold reached!
		const detection = guard.recordTurn(makeReadTurn("turn-2", "src/core.ts:80-120"));
		expect(detection).not.toBeNull();
		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
			resultSummary: "Requested lines are already present in previous turn context",
			argumentsSummary: '{"path":"src/core.ts:80-120"}',
		});

		// 3rd subsumed read: guard steers once at the threshold to avoid prompt noise
		expect(guard.recordTurn(makeReadTurn("turn-3", "src/core.ts:90-110"))).toBeNull();
	});

	it("does not fire on partially-overlapping reads (scrolling or context expansion)", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Initial window: lines 1-50
		expect(guard.recordTurn(makeReadTurn("turn-0", "src/core.ts:1-50"))).toBeNull();

		// Overlapping scroll: lines 40-100 (contains new lines 51-100) -> NOT subsumed
		expect(guard.recordTurn(makeReadTurn("turn-1", "src/core.ts:40-100"))).toBeNull();

		// Another overlapping scroll: lines 90-160 (contains new lines 101-160) -> NOT subsumed
		expect(guard.recordTurn(makeReadTurn("turn-2", "src/core.ts:90-160"))).toBeNull();

		// Another overlapping scroll: lines 150-220 (contains new lines 161-220) -> NOT subsumed
		expect(guard.recordTurn(makeReadTurn("turn-3", "src/core.ts:150-220"))).toBeNull();
	});

	it("does not fire when the file changed between reads (different snapshot tag resets history)", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Initial read with tag 1A2B covering 1-200
		expect(
			guard.recordTurn(
				makeReadTurn("turn-0", "src/core.ts:1-200", "[src/core.ts#1A2B]\n1: initial\n200: initial\n"),
			),
		).toBeNull();

		// Read returning a NEW snapshot tag (file modified externally: #3C4D)
		// It records a narrow range 50-100 and replaces history for src/core.ts
		expect(
			guard.recordTurn(
				makeReadTurn("turn-1", "src/core.ts:50-100", "[src/core.ts#3C4D]\n50: modified\n100: modified\n"),
			),
		).toBeNull();

		// Next read asks for 1-200. Under the old tag (1A2B) this would be subsumed, but under
		// the new tag (#3C4D) only 50-100 is known, so 1-200 is NOT subsumed! Count resets to 0.
		expect(
			guard.recordTurn(
				makeReadTurn("turn-2", "src/core.ts:1-200", "[src/core.ts#3C4D]\n1: modified\n200: modified\n"),
			),
		).toBeNull();

		// 1st subsumed read under the new 1-200 history -> count = 1
		expect(
			guard.recordTurn(makeReadTurn("turn-3", "src/core.ts:60-80", "[src/core.ts#3C4D]\n60: line\n80: line\n")),
		).toBeNull();

		// 2nd subsumed read under the new 1-200 history -> count = 2 -> triggers detection!
		const detection = guard.recordTurn(
			makeReadTurn("turn-4", "src/core.ts:66-70", "[src/core.ts#3C4D]\n66: line\n70: line\n"),
		);
		expect(detection).not.toBeNull();
		expect(detection?.count).toBe(2);
	});

	it("resets read history on mutating tool calls (edit, write, ast_edit, patch, bash)", () => {
		const mutatingTools: Array<{
			name: "edit" | "write" | "ast_edit" | "patch" | "bash";
			args: Record<string, unknown>;
		}> = [
			{ name: "edit", args: { input: "[src/core.ts#1A2B]\nSWAP 10.=10:\n+new content\n" } },
			{ name: "write", args: { path: "src/core.ts", content: "new full file" } },
			{ name: "ast_edit", args: { paths: ["src/core.ts"], ops: [{ pat: "$A", out: "$A" }] } },
			{ name: "patch", args: { path: "src/core.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" } },
			{ name: "bash", args: { command: "git checkout src/core.ts" } },
		];

		for (const mutator of mutatingTools) {
			const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

			// Initial read 1-200
			expect(guard.recordTurn(makeReadTurn("read-0", "src/core.ts:1-200"))).toBeNull();

			// 1st subsumed read -> count = 1
			expect(guard.recordTurn(makeReadTurn("read-1", "src/core.ts:50-100"))).toBeNull();

			// Mutating tool executes
			expect(guard.recordTurn(makeMutatingTurn("mutate", mutator.name, mutator.args))).toBeNull();

			// Re-read 50-100: read history was wiped by mutation, so this is treated as fresh
			expect(guard.recordTurn(makeReadTurn("read-2", "src/core.ts:50-100"))).toBeNull();

			// Next subsumed read within 50-100 is count 1, not count 2
			expect(guard.recordTurn(makeReadTurn("read-3", "src/core.ts:60-80"))).toBeNull();
		}
	});

	it("does not fire on multi-target reads when only some targets are subsumed", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Baseline: read foo.ts:1-100
		expect(guard.recordTurn(makeReadTurn("read-0", "src/foo.ts:1-100"))).toBeNull();

		// Read foo.ts:20-50 (subsumed) AND bar.ts:1-50 (new target, not in history)
		// `allSubsumed` must be false because bar.ts has not been read yet.
		expect(guard.recordTurn(makeReadTurn("read-1", "src/foo.ts:20-50;src/bar.ts:1-50"))).toBeNull();

		// Now both foo.ts (1-100) and bar.ts (1-50) are in history.
		// 1st fully-subsumed multi-target read -> count = 1
		expect(guard.recordTurn(makeReadTurn("read-2", "src/foo.ts:30-40;src/bar.ts:10-20"))).toBeNull();

		// 2nd fully-subsumed multi-target read -> count = 2 -> triggers detection!
		const detection = guard.recordTurn(makeReadTurn("read-3", "src/foo.ts:32-38;src/bar.ts:12-18"));
		expect(detection).not.toBeNull();
		expect(detection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
			resultSummary: "Requested lines are already present in previous turn context",
		});
	});

	it("respects the readSubsumptionThreshold default of 3 and observes behavior change when set to 1", () => {
		// 1. Default threshold (omitted option -> default is 3)
		const guardDefault = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });

		// Baseline read
		expect(guardDefault.recordTurn(makeReadTurn("d-0", "src/core.ts:1-100"))).toBeNull();

		// 1st and 2nd subsumed reads -> both silent under the default threshold of 3
		expect(guardDefault.recordTurn(makeReadTurn("d-1", "src/core.ts:20-50"))).toBeNull();
		expect(guardDefault.recordTurn(makeReadTurn("d-2", "src/core.ts:25-35"))).toBeNull();

		// 3rd subsumed read -> triggers detection under the default threshold of 3
		const defaultDetection = guardDefault.recordTurn(makeReadTurn("d-3", "src/core.ts:28-32"));
		expect(defaultDetection).not.toBeNull();
		expect(defaultDetection?.count).toBe(3);

		// 2. Explicit threshold of 1
		const guardThreshold1 = new ToolCallLoopGuard({
			threshold: 5,
			exemptTools: [],
			readSubsumptionThreshold: 1,
		});

		// Baseline read
		expect(guardThreshold1.recordTurn(makeReadTurn("t1-0", "src/core.ts:1-100"))).toBeNull();

		// 1st subsumed read -> with threshold 1, this immediately triggers steering!
		const immediateDetection = guardThreshold1.recordTurn(makeReadTurn("t1-1", "src/core.ts:20-50"));
		expect(immediateDetection).not.toBeNull();
		expect(immediateDetection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 1,
			resultSummary: "Requested lines are already present in previous turn context",
		});
	});

	it("preserves the prompt-cache prefix without rewriting or mutating prior turns", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		const turn0 = makeReadTurn("turn-0", "src/core.ts:1-100");
		const turn1 = makeReadTurn("turn-1", "src/core.ts:10-50");
		const turn2 = makeReadTurn("turn-2", "src/core.ts:20-40");

		// Deep snapshot of messages before recording
		const turn0MessageBefore = JSON.stringify(turn0.message);
		const turn0ResultsBefore = JSON.stringify(turn0.toolResults);
		const turn1MessageBefore = JSON.stringify(turn1.message);
		const turn1ResultsBefore = JSON.stringify(turn1.toolResults);
		const turn2MessageBefore = JSON.stringify(turn2.message);
		const turn2ResultsBefore = JSON.stringify(turn2.toolResults);

		// Record turns
		expect(guard.recordTurn(turn0)).toBeNull();
		expect(guard.recordTurn(turn1)).toBeNull();
		const detection = guard.recordTurn(turn2);

		// Verify detection payload
		expect(detection).not.toBeNull();
		expect(detection?.kind).toBe("repeated_tool_call");

		// Invariant: The guard must never mutate input turn objects or message history in place,
		// ensuring exact prompt-cache prefix stability across turns.
		expect(JSON.stringify(turn0.message)).toBe(turn0MessageBefore);
		expect(JSON.stringify(turn0.toolResults)).toBe(turn0ResultsBefore);
		expect(JSON.stringify(turn1.message)).toBe(turn1MessageBefore);
		expect(JSON.stringify(turn1.toolResults)).toBe(turn1ResultsBefore);
		expect(JSON.stringify(turn2.message)).toBe(turn2MessageBefore);
		expect(JSON.stringify(turn2.toolResults)).toBe(turn2ResultsBefore);

		// Once steered, subsequent turns do not repeatedly inject steer mutations
		const turn3 = makeReadTurn("turn-3", "src/core.ts:25-30");
		expect(guard.recordTurn(turn3)).toBeNull();
	});
});
