/**
 * WHY: `parseReadTarget` previously split the read path on the first colon, causing
 * false loop-guard aborts across three major categories of path targets:
 * 1. URI schemes (`skill://alpha`, `rule://beta`, `ssh://host/file`): the split took the scheme
 *    name as the base path (e.g. `skill`), collapsing all distinct URIs under the same scheme
 *    into one history entry and falsely aborting consecutive reads of different resources.
 * 2. Windows absolute paths (`C:\dir\file.ts`, `C:/dir/file.ts`): the split took the drive letter
 *    (e.g. `C`), collapsing all file reads on the same drive and falsely aborting the second file read.
 * 3. Compound selectors (`file.ts:raw:2-4`, `file.ts:2-4:raw`): failed to match raw or numeric range
 *    and fell back to treating the entire file as read verbatim, falsely subsuming later disjoint ranges.
 *    Open-ended selectors (`file.ts:50-`) also collapsed to single-line reads rather than 50-to-EOF.
 *
 * CLASS IT CLOSES: All read tool path targets containing URI schemes (derived at runtime from
 * the internal URL router plus web schemes), Windows drive prefixes, compound raw+range selectors,
 * open-ended line ranges, and multi-range lists.
 *
 * GAP IT LEAVES: Does not perform filesystem I/O or invoke protocol handlers directly; covers
 * loop-guard path parsing, history tracking, and subsumption detection through `ToolCallLoopGuard`.
 */

import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../../coding-agent/src/internal-urls/router";
import type { AssistantMessage } from "../src/types";
import { ToolCallLoopGuard, type ToolCallLoopTurn } from "../src/utils/tool-call-loop-guard";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function makeReadTurn(id: string, path: string, text = "file content\n"): ToolCallLoopTurn {
	return {
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
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
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: `[${path}#1A2B]\n${text}` }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
}

describe("ToolCallLoopGuard read path parsing and subsumption", () => {
	it("derives all registered schemes at runtime and ensures distinct URIs per scheme do not collapse", () => {
		const registeredSchemes = InternalUrlRouter.instance().schemes().sort();
		// Fail by default if the router schemes change without updating known classification
		const expectedKnownSchemes = [
			"agent",
			"artifact",
			"history",
			"issue",
			"local",
			"mcp",
			"memory",
			"pr",
			"rule",
			"skill",
			"ssh",
			"vault",
			"veyyon",
		].sort();
		expect(registeredSchemes).toEqual(expectedKnownSchemes);

		const allSchemesToTest = [...registeredSchemes, "http", "https"];

		for (const scheme of allSchemesToTest) {
			const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
			const target1 = `${scheme}://resource-alpha`;
			const target2 = `${scheme}://resource-beta`;
			const target3 = `${scheme}://resource-gamma`;

			expect(guard.recordTurn(makeReadTurn("turn-1", target1))).toBeNull();
			expect(guard.recordTurn(makeReadTurn("turn-2", target2))).toBeNull();
			expect(guard.recordTurn(makeReadTurn("turn-3", target3))).toBeNull();
		}
	});

	it("does not trip the subsumption guard when reading three distinct skill:// URIs in a row", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		expect(guard.recordTurn(makeReadTurn("read-1", "skill://alpha/doc.md"))).toBeNull();
		expect(guard.recordTurn(makeReadTurn("read-2", "skill://beta/doc.md"))).toBeNull();
		expect(guard.recordTurn(makeReadTurn("read-3", "skill://gamma/doc.md"))).toBeNull();
	});

	it("does not collapse different absolute Windows paths on the same drive", () => {
		const guardBackslash = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guardBackslash.recordTurn(makeReadTurn("win-1", "C:\\Users\\me\\project\\src\\a.ts"))).toBeNull();
		expect(guardBackslash.recordTurn(makeReadTurn("win-2", "C:\\Users\\me\\project\\src\\b.ts"))).toBeNull();
		expect(guardBackslash.recordTurn(makeReadTurn("win-3", "C:\\Users\\me\\project\\src\\c.ts"))).toBeNull();

		const guardSlash = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guardSlash.recordTurn(makeReadTurn("win-s1", "C:/Users/me/project/src/a.ts"))).toBeNull();
		expect(guardSlash.recordTurn(makeReadTurn("win-s2", "C:/Users/me/project/src/b.ts"))).toBeNull();
		expect(guardSlash.recordTurn(makeReadTurn("win-s3", "C:/Users/me/project/src/c.ts"))).toBeNull();

		const guardDriveD = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guardDriveD.recordTurn(makeReadTurn("win-d1", "D:\\Data\\one.txt"))).toBeNull();
		expect(guardDriveD.recordTurn(makeReadTurn("win-d2", "D:\\Data\\two.txt"))).toBeNull();
	});

	it("does not mark whole file verbatim for compound :raw:2-4 and :2-4:raw reads", () => {
		// Reading lines 2-4 with raw mode must not subsume subsequent disjoint lines 5-10 and 11-20
		const guard1 = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guard1.recordTurn(makeReadTurn("r1", "src/foo.ts:raw:2-4", "2: b\n3: c\n4: d\n"))).toBeNull();
		expect(guard1.recordTurn(makeReadTurn("r2", "src/foo.ts:5-10", "5: e\n10: j\n"))).toBeNull();
		expect(guard1.recordTurn(makeReadTurn("r3", "src/foo.ts:11-20", "11: k\n20: t\n"))).toBeNull();

		// Same for :2-4:raw order
		const guard2 = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guard2.recordTurn(makeReadTurn("r4", "src/foo.ts:2-4:raw", "2: b\n3: c\n4: d\n"))).toBeNull();
		expect(guard2.recordTurn(makeReadTurn("r5", "src/foo.ts:5-10", "5: e\n10: j\n"))).toBeNull();
		expect(guard2.recordTurn(makeReadTurn("r6", "src/foo.ts:11-20", "11: k\n20: t\n"))).toBeNull();

		// Reading consecutive distinct compound raw ranges on the same file must not trigger
		const guard3 = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guard3.recordTurn(makeReadTurn("r7", "src/foo.ts:raw:2-4", "2: b\n"))).toBeNull();
		expect(guard3.recordTurn(makeReadTurn("r8", "src/foo.ts:raw:5-10", "5: e\n"))).toBeNull();
		expect(guard3.recordTurn(makeReadTurn("r9", "src/foo.ts:raw:11-20", "11: k\n"))).toBeNull();

		// Subsumed reads within a compound raw range DO trigger when actually contained
		const guard4 = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });
		expect(guard4.recordTurn(makeReadTurn("r10", "src/foo.ts:raw:2-20", "2: b\n20: t\n"))).toBeNull();
		expect(guard4.recordTurn(makeReadTurn("r11", "src/foo.ts:3-5", "3: c\n5: e\n"))).toBeNull();
		const detection = guard4.recordTurn(makeReadTurn("r12", "src/foo.ts:6-8", "6: f\n8: h\n"));
		expect(detection).not.toBeNull();
		expect(detection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
		});
	});

	it("supports semicolon-delimited multi-target paths, multi-ranges, and offset ranges", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Semicolon multi-target with schemes
		expect(guard.recordTurn(makeReadTurn("m1", "skill://alpha/doc.md;skill://beta/doc.md"))).toBeNull();
		expect(guard.recordTurn(makeReadTurn("m2", "skill://gamma/doc.md;skill://delta/doc.md"))).toBeNull();

		// Multi-range selector and offset range
		expect(guard.recordTurn(makeReadTurn("m3", "src/foo.ts:5-16,960-973"))).toBeNull();
		expect(guard.recordTurn(makeReadTurn("m4", "src/foo.ts:50+150"))).toBeNull();
		expect(guard.recordTurn(makeReadTurn("m5", "src/foo.ts:conflicts"))).toBeNull();
	});

	it("handles open-ended :50- ranges to EOF and correctly checks subsumption", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Read 50-
		expect(guard.recordTurn(makeReadTurn("open-1", "src/foo.ts:50-", "50: line\n"))).toBeNull();

		// Reading a disjoint range before 50 (e.g. 10-20) is NOT subsumed
		expect(guard.recordTurn(makeReadTurn("open-2", "src/foo.ts:10-20", "10: line\n"))).toBeNull();

		// Subsumed read #1 (lines 60-70 are within 50-EOF) -> count 1
		expect(guard.recordTurn(makeReadTurn("open-3", "src/foo.ts:60-70", "60: line\n"))).toBeNull();

		// Subsumed read #2 (lines 80-90 are within 50-EOF) -> count 2 -> triggers subsumption loop guard
		const detection = guard.recordTurn(makeReadTurn("open-4", "src/foo.ts:80-90", "80: line\n"));
		expect(detection).not.toBeNull();
		expect(detection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
		});
	});

	it("positive control: still detects repeated reads of identical targets and genuine subsumed reads", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], readSubsumptionThreshold: 2 });

		// Read range 1-100
		expect(guard.recordTurn(makeReadTurn("full-1", "src/foo.ts:1-100", "line 1\nline 2\n"))).toBeNull();

		// Subsumed read #1: range 1-10 within 1-100 -> count 1
		expect(guard.recordTurn(makeReadTurn("full-2", "src/foo.ts:1-10", "line 1\n"))).toBeNull();

		// Subsumed read #2: range 20-30 within 1-100 -> count 2 -> triggers!
		const detection = guard.recordTurn(makeReadTurn("full-3", "src/foo.ts:20-30", "line 20\n"));
		expect(detection).not.toBeNull();
		expect(detection).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 2,
			resultSummary: "Requested lines are already present in previous turn context",
		});
	});
});
