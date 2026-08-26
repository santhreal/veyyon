import type { ArmResult } from "./src/aggregate/types";

export * from "./src/aggregate";

/**
 * A trial result with every measurement still unknown, which is the honest
 * starting state for a trial before execution or during an early infrastructure
 * abort.
 *
 * WHY THIS IS THE SINGLE OWNER OF THE BLANK SHAPE. Before this existed the blank
 * `ArmResult` was hand-written in three places in `run.ts` and a fourth in the
 * unit tests. The copies drifted: the parse path dropped `error`, and the
 * reaggregate error path dropped `argotHandlesLoaded` and `encodeHeadroom`. A
 * reaggregate of a finished run therefore erased those two fields from the
 * written `results.json`, which silently broke the `vocab handles` and headroom
 * sections on any later render. Nothing caught it because the package previously
 * had no `check:types` script and was skipped by the workspace typecheck.
 *
 * `null` throughout means "not measured", never zero. Zero is a real, different
 * answer: a dictionary that loaded no handles is a corpus fact, not missing data.
 */
export function emptyArmResult(arm: string, task: string, repeat: number): ArmResult {
	return {
		arm,
		task,
		repeat,
		reward: null,
		partial: null,
		f2p: null,
		p2p: null,
		inputTokens: null,
		outputTokens: null,
		cacheTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		promptCacheInvalidations: null,
		costUsd: null,
		agentSeconds: null,
		argotLoadCalls: null,
		assistantMsgsWithSigil: null,
		argotPreamblePresent: null,
		argotHandlesLoaded: null,
		argotHandlesTaught: null,
		encodeHeadroom: null,
		toolCalls: null,
		error: null,
		exceptionInfo: null,
	};
}
