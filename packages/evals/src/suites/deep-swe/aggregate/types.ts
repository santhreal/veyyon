/**
 * Core result types for DeepSWE evaluations.
 */

import type { ArmResult } from "../../../core";

export type { ArmResult } from "../../../core";

/**
 * Runtime list of every field name declared on ArmResult.
 *
 * WHY THIS LIST AND EXHAUSTIVENESS CHECK EXIST. A hand-written blank trial result
 * easily forgets optional or newly added fields. To prevent drift:
 * 1. ARM_RESULT_FIELDS lists every field name at runtime.
 * 2. It is typed with `satisfies readonly (keyof ArmResult)[]` to forbid extraneous keys.
 * 3. The exhaustiveness check `Record<keyof ArmResult, true>` ensures that if a field
 *    is added to ArmResult without being added to ARM_RESULT_FIELDS, TypeScript fails
 *    to compile with a missing property error.
 */
export const ARM_RESULT_FIELDS = [
	"arm",
	"task",
	"repeat",
	"reward",
	"partial",
	"f2p",
	"p2p",
	"inputTokens",
	"outputTokens",
	"costUsd",
	"cacheTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"promptCacheInvalidations",
	"agentSeconds",
	"argotLoadCalls",
	"assistantMsgsWithSigil",
	"argotPreamblePresent",
	"argotHandlesLoaded",
	"argotHandlesTaught",
	"encodeHeadroom",
	"toolCalls",
	"error",
	"exceptionInfo",
] as const satisfies readonly (keyof ArmResult)[];

type ArmResultFieldTuple = typeof ARM_RESULT_FIELDS;
type ArmResultField = ArmResultFieldTuple[number];

/**
 * Compile-time exhaustiveness check: Record<keyof ArmResult, true> requires every key
 * of ArmResult. If a key is missing from ArmResultField, assigning an object typed as
 * Record<ArmResultField, true> or asserting bidirectional assignability fails closed.
 */
type _ArmResultFieldExhaustiveness =
	Record<keyof ArmResult, true> extends Record<ArmResultField, true>
		? Record<ArmResultField, true> extends Record<keyof ArmResult, true>
			? true
			: never
		: never;

const _armResultFieldsExhaustive: _ArmResultFieldExhaustiveness = true;

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	argotLoadCalls: number;
	assistantMsgsWithSigil: number;
	toolCalls: Record<string, number>;
}

export interface CellSummary {
	total: number;
	errors: number;
	timedOut: number;
	/** Trials that settled with no reward and no error. Excluded from `n`, never averaged as zero. */
	unscored: number;
	n: number;
	passes: number;
	passRate: number | null;
	stdErr: number | null;
	wilsonLow: number | null;
	wilsonHigh: number | null;
	meanReward: number | null;
	meanPartial: number | null;
	meanOutputTokens: number | null;
	meanInputTokens: number | null;
	meanCostUsd: number | null;
	sumOutputTokens: number;
	sumCostUsd: number;
	sumInputTokens: number;
	sumCacheTokens: number;
	sumAgentSeconds: number;
	costPriced: boolean;
	refCost: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		total: number;
	};
	/** Rows the reference cost section prices: those that reached a grader, graded or not. */
	refPricedSamples: number;
	refCostMeasurable: boolean;
}
