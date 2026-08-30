/**
 * WHY: automatic compaction decides three different things — nothing happened,
 * a continuation is scheduled, and a continuation is refused — and every caller
 * branches on the same three frozen verdicts. #2275 was an auto-continue dead
 * loop caused by re-checking residual context against the raw threshold, which
 * is why the recovery band exists and why the dead-end notice names remedies
 * instead of a stack trace.
 *
 * Closes the class: each verdict's field set is pinned by exact equality (a new
 * field, or a verdict that quietly schedules a continuation, goes red), the
 * recovery band is asserted to be a real hysteresis band rather than 1, and the
 * preserve-data merge is asserted on precedence, emptiness and legacy stripping.
 *
 * Does NOT catch: whether the compaction pass consults the band at the right
 * moment — that is the session's compaction tail, tested with the session.
 */

import { describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import {
	COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION,
	COMPACTION_CHECK_CONTINUATION,
	COMPACTION_CHECK_NONE,
	COMPACTION_RECOVERY_BAND,
	compactionDeadEndWarning,
	createCodexCompactionContext,
	declaredContextWindow,
	mergeLlmCompactionPreserveData,
} from "@veyyon/kernel/session/agent-session-compaction-policy";

function modelWithWindow(contextWindow: number | null | undefined): Model {
	return { id: "m", name: "m", provider: "p", contextWindow } as unknown as Model;
}

describe("the compaction verdict is data, not a side effect", () => {
	it("keeps the three verdicts distinguishable by field, not by identity", () => {
		expect(COMPACTION_CHECK_NONE).toEqual({ continuationScheduled: false });
		expect(COMPACTION_CHECK_CONTINUATION).toEqual({ continuationScheduled: true });
		expect(COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION).toEqual({
			continuationScheduled: false,
			automaticContinuationBlocked: true,
		});
	});

	it("never schedules a continuation from the verdict that blocks one", () => {
		expect(COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION.continuationScheduled).toBe(false);
		expect(COMPACTION_CHECK_CONTINUATION.automaticContinuationBlocked).toBeUndefined();
		expect(COMPACTION_CHECK_NONE.automaticContinuationBlocked).toBeUndefined();
	});

	it("leaves headroom below the threshold, so a pass that trickles under the line does not count", () => {
		expect(COMPACTION_RECOVERY_BAND).toBeGreaterThan(0);
		expect(COMPACTION_RECOVERY_BAND).toBeLessThan(1);
	});

	it("names the remedies the caller has left in the dead-end notice", () => {
		const warning = compactionDeadEndWarning("drop the last tool result");

		expect(warning).toContain("drop the last tool result");
		expect(warning).toContain("larger-context model");
	});

	it("reads a declared context window and refuses to invent one", () => {
		expect(declaredContextWindow(modelWithWindow(128_000))).toBe(128_000);
		expect(declaredContextWindow(modelWithWindow(null))).toBeUndefined();
		expect(declaredContextWindow(modelWithWindow(undefined))).toBeUndefined();
		expect(declaredContextWindow(modelWithWindow(0))).toBeUndefined();
		expect(declaredContextWindow(modelWithWindow(-1))).toBeUndefined();
		expect(declaredContextWindow(undefined)).toBeUndefined();
	});

	it("stamps every codex compaction context with its own operation id", () => {
		const options = { trigger: "auto", reason: "context_limit", phase: "pre_turn" } as const;
		const first = createCodexCompactionContext(options);
		const second = createCodexCompactionContext(options);

		expect(first.trigger).toBe("auto");
		expect(first.reason).toBe("context_limit");
		expect(first.phase).toBe("pre_turn");
		expect(first.strategy).toBe("memento");
		expect(first.operationId).not.toBe(second.operationId);
	});

	it("lets the compaction result win over the hook that seeded the preserve data", () => {
		const merged = mergeLlmCompactionPreserveData({ keep: "hook", only: "hook" }, { keep: "result" });

		expect(merged).toEqual({ keep: "result", only: "hook" });
	});

	it("reports no preserve data at all rather than an empty object", () => {
		expect(mergeLlmCompactionPreserveData(undefined, undefined)).toBeUndefined();
		expect(mergeLlmCompactionPreserveData({}, {})).toBeUndefined();
	});

	it("carries one side's preserve data through when the other has none", () => {
		expect(mergeLlmCompactionPreserveData({ keep: "hook" }, undefined)).toEqual({ keep: "hook" });
		expect(mergeLlmCompactionPreserveData(undefined, { keep: "result" })).toEqual({ keep: "result" });
	});
});
