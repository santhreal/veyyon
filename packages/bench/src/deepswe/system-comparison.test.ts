import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	aggregateSystemComparison,
	COMPARISON_MODEL,
	COMPARISON_TASK_LIST,
	COMPARISON_TASK_LIST_SHA256,
	ComparisonRejected,
	type ComparisonSystem,
	renderSystemComparison,
	type SystemTrialResult,
} from "./system-comparison";

const TASKS = ["task-a", "task-b"] as const;
const SYSTEMS = ["veyyon", "factory", "hermes"] as const;

function trial(system: ComparisonSystem, task: string): SystemTrialResult {
	const veyyon = system === "veyyon";
	return {
		system,
		task,
		repeat: 0,
		requestedModel: COMPARISON_MODEL,
		resolvedModel: COMPARISON_MODEL,
		reward: veyyon ? 1 : 0.5,
		qualitativeScore: null,
		recoveryReads: null,
		recoveryTokens: null,
		inputTokens: veyyon ? 20 : 40,
		outputTokens: veyyon ? 10 : 20,
		cacheTokens: veyyon ? 0 : 10,
		wallSeconds: veyyon ? 10 : 20,
		providerCostSupported: true,
		costUsd: veyyon ? 0.1 : 0.3,
		artifacts: {
			patch: `${system}/${task}/model.patch`,
			transcript: `${system}/${task}/transcript.jsonl`,
			log: `${system}/${task}/agent.log`,
		},
		execution: {
			taskInstructionsHash: `instructions-${task}`,
			repositoryStateHash: `repo-${task}`,
			wallClockLimitSeconds: 5400,
			temperature: 0,
			samplingDescription: "greedy temperature 0",
		},
		replay: null,
		nativeCompaction: null,
		error: null,
	};
}

function completeResults(): SystemTrialResult[] {
	return TASKS.flatMap(task => SYSTEMS.map(system => trial(system, task)));
}

function replaceSystem(
	results: readonly SystemTrialResult[],
	system: ComparisonSystem,
	change: Partial<SystemTrialResult>,
): SystemTrialResult[] {
	return results.map(result => (result.system === system ? { ...result, ...change } : result));
}

test("the initial comparison task list is the unchanged pinned 10-task artifact", () => {
	const taskList = fs.readFileSync(new URL(COMPARISON_TASK_LIST, import.meta.url));
	const tasks = taskList
		.toString("utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"));

	expect(createHash("sha256").update(taskList).digest("hex")).toBe(COMPARISON_TASK_LIST_SHA256);
	expect(tasks).toHaveLength(10);
});

describe("cross-system result pairing", () => {
	test("pairs all systems by task and preserves the fixed task order", () => {
		const comparison = aggregateSystemComparison([...completeResults()].reverse(), TASKS);

		expect(comparison.pairs.map(pair => pair.task)).toEqual([...TASKS]);
		expect(comparison.pairs[0]?.results.veyyon.system).toBe("veyyon");
		expect(comparison.pairs[0]?.results.factory.system).toBe("factory");
		expect(comparison.pairs[0]?.results.hermes.system).toBe("hermes");
		expect(comparison.totals.veyyon.tasks).toBe(2);
	});

	test("rejects missing pairs and zero-token infrastructure results", () => {
		const missing = completeResults().filter(result => !(result.system === "hermes" && result.task === "task-b"));
		expect(() => aggregateSystemComparison(missing, TASKS)).toThrow(/hermes\/task-b\/r0: missing paired result/);

		const zeroTokens = replaceSystem(completeResults(), "factory", {
			inputTokens: 0,
			outputTokens: 0,
			cacheTokens: 0,
		});
		expect(() => aggregateSystemComparison(zeroTokens, TASKS)).toThrow(ComparisonRejected);
		expect(() => aggregateSystemComparison(zeroTokens, TASKS)).toThrow(
			/zero-token result is an infrastructure failure/,
		);
	});

	test("rejects a resolved-model drift and non-identical replay checkpoint", () => {
		const wrongModel = replaceSystem(completeResults(), "factory", { resolvedModel: "some-fallback" });
		expect(() => aggregateSystemComparison(wrongModel, TASKS)).toThrow(/resolved model.*some-fallback/);

		const replayResults = completeResults().map(result => ({
			...result,
			qualitativeScore: result.system === "veyyon" ? 0.9 : 0.5,
			replay: {
				manifestSha256: "a".repeat(64),
				sourceSessionId: "session-1",
				sourceSessionArtifacts: ["/source/session.jsonl"],
				repositoryCheckpoint:
					result.system === "hermes" && result.task === "task-b" ? "/wrong-checkpoint" : "/checkpoint",
				compactionBoundary: "message-42",
				sourceThresholdTokens: 100_000,
				sourceContextTokens: 100_500,
				continuationId: `continuation-${result.task}`,
				continuationArtifact: `/continuation-${result.task}.json`,
			},
			nativeCompaction: {
				native: true,
				artifact: `/${result.system}/${result.task}/compaction.json`,
				beforeTokens: 100_500,
				afterTokens: 50_000,
			},
		}));
		expect(() => aggregateSystemComparison(replayResults, TASKS)).toThrow(/same frozen checkpoint\/continuation/);
	});

	test("real replay without qualitative judge output is unsupported, never a quality pass", () => {
		const replayResults = completeResults().map(result => ({
			...result,
			recoveryReads: result.system === "veyyon" ? 2 : 4,
			recoveryTokens: result.system === "veyyon" ? 100 : 200,
			replay: {
				manifestSha256: "a".repeat(64),
				sourceSessionId: "session-1",
				sourceSessionArtifacts: ["/source/session.jsonl"],
				repositoryCheckpoint: "/checkpoint",
				compactionBoundary: "message-42@user-2",
				sourceThresholdTokens: 100_000,
				sourceContextTokens: 100_500,
				continuationId: `continuation-${result.task}`,
				continuationArtifact: `/continuation-${result.task}.json`,
			},
			nativeCompaction: {
				native: true,
				artifact: `/${result.system}/${result.task}/compaction.json`,
				beforeTokens: null,
				afterTokens: null,
			},
		}));
		const missingNativeEvidence = replayResults.map(result =>
			result.system === "hermes" ? { ...result, nativeCompaction: null } : result,
		);
		expect(() => aggregateSystemComparison(missingNativeEvidence, TASKS)).toThrow(/no native compaction evidence/);
		const comparison = aggregateSystemComparison(replayResults, TASKS);
		expect(comparison.totals.veyyon.recoveryReads).toBe(4);
		expect(comparison.totals.veyyon.recoveryTokens).toBe(200);

		expect(comparison.competitors[0]?.quality.status).toBe("unsupported");
		expect(comparison.competitors[0]?.overall).toBe("unsupported");
		expect(comparison.overall).toBe("unsupported");
	});
});

describe("ratio math and hard gates", () => {
	test("computes exact token categories, totals, ratios, and passing gates", () => {
		const comparison = aggregateSystemComparison(completeResults(), TASKS);
		const factory = comparison.competitors.find(row => row.competitor === "factory");

		expect(comparison.totals.veyyon).toMatchObject({
			inputTokens: 40,
			outputTokens: 20,
			cacheTokens: 0,
			totalTokens: 60,
			wallSeconds: 20,
			costUsd: 0.2,
		});
		expect(factory?.ratios.inputTokens.value).toBe(0.5);
		expect(factory?.ratios.outputTokens.value).toBe(0.5);
		expect(factory?.ratios.cacheTokens.value).toBe(0);
		expect(factory?.ratios.totalTokens.value).toBeCloseTo(3 / 7);
		expect(factory?.ratios.price.value).toBeCloseTo(1 / 3);
		expect(factory?.quality.status).toBe("pass");
		expect(factory?.wallTime.status).toBe("pass");
		expect(factory?.totalTokens.status).toBe("pass");
		expect(factory?.price.status).toBe("pass");
		expect(comparison.overall).toBe("pass");
	});

	test("fails each hard gate independently at its strict boundary", () => {
		const quality = replaceSystem(completeResults(), "veyyon", { reward: 0.5 });
		expect(aggregateSystemComparison(quality, TASKS).competitors[0]?.quality.status).toBe("fail");

		const time = replaceSystem(completeResults(), "veyyon", { wallSeconds: 20 });
		expect(aggregateSystemComparison(time, TASKS).competitors[0]?.wallTime.status).toBe("fail");

		const tokens = replaceSystem(completeResults(), "veyyon", {
			inputTokens: 40,
			outputTokens: 20,
			cacheTokens: 10,
		});
		expect(aggregateSystemComparison(tokens, TASKS).competitors[0]?.totalTokens.status).toBe("fail");
		const exactHalf = replaceSystem(completeResults(), "veyyon", {
			inputTokens: 25,
			outputTokens: 10,
			cacheTokens: 0,
		});
		expect(aggregateSystemComparison(exactHalf, TASKS).competitors[0]?.totalTokens.status).toBe("pass");

		const price = replaceSystem(completeResults(), "veyyon", { costUsd: 0.15 });
		expect(aggregateSystemComparison(price, TASKS).competitors[0]?.price.status).toBe("fail");
	});

	test("an unsupported competitor price is explicit and can never pass", () => {
		const unsupported = replaceSystem(completeResults(), "factory", {
			providerCostSupported: false,
			costUsd: null,
		});
		const comparison = aggregateSystemComparison(unsupported, TASKS);
		const factory = comparison.competitors.find(row => row.competitor === "factory");

		expect(factory?.ratios.price).toEqual({
			value: null,
			supported: false,
			reason: "provider price is unsupported",
		});
		expect(factory?.price.status).toBe("unsupported");
		expect(factory?.overall).toBe("unsupported");
		expect(comparison.overall).toBe("unsupported");
		const report = renderSystemComparison(comparison);
		expect(report).toContain("| factory |");
		expect(report).toContain("| unsupported |");
		expect(report).toContain("**Overall: unsupported.**");
	});
});
