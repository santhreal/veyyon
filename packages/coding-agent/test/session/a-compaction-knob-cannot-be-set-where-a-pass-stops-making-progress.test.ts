/**
 * WHY: the compaction knobs are numbers whose doc comments state constraints
 * that nothing checked. Each one has a value at which compaction still runs,
 * still reports success, and stops making progress — a truncation minimum below
 * the edges it keeps cuts nothing, a recovery band of 1 removes the hysteresis
 * and restores the auto-continue dead loop, an idle flush shorter than the
 * provider's cache TTL busts a prefix that is still warm. None of those fail
 * loudly; they degrade into a loop or a bill.
 *
 * The class this closes is the knob whose comment says MUST and whose value
 * nothing holds to it. Each constant is asserted against the relation its own
 * doc states, not against the number it happens to hold, so retuning a knob
 * inside its safe range stays green and moving one past the edge goes red.
 *
 * `declaredContextWindow` is here for the same reason: null in
 * `Model.contextWindow` means the model never stated a window, and the whole
 * point is that no default is substituted for it. A helper that returned a
 * plausible number instead would cap compaction against a figure nobody stated.
 *
 * Not covered: whether a pass that respects these knobs frees enough context.
 * That is compaction's own behavior and is exercised against a real session.
 */

import { describe, expect, test } from "bun:test";
import type { Model } from "@veyyon/ai";
import {
	COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION,
	COMPACTION_CHECK_CONTINUATION,
	COMPACTION_CHECK_NONE,
	COMPACTION_RECOVERY_BAND,
	type CodexCompactionContextOptions,
	compactionDeadEndWarning,
	createCodexCompactionContext,
	declaredContextWindow,
	PRUNE_CACHE_WARM_SUFFIX_TOKENS,
	PRUNE_IDLE_FLUSH_MS,
	TRUNCATION_KEEP_EDGE_TOKENS,
	TRUNCATION_MIN_TEXT_TOKENS,
} from "../../src/session/compaction-policy";

const model = (contextWindow: unknown): Model => ({ contextWindow }) as Model;

const ONE_HOUR_MS = 60 * 60_000;

describe("a knob is held to the relation its doc states", () => {
	test("the truncation minimum leaves a middle worth cutting", () => {
		// At or below 2x the kept edges there is nothing between them to remove,
		// so the pass writes a marker and frees nothing.
		expect(TRUNCATION_MIN_TEXT_TOKENS).toBeGreaterThan(2 * TRUNCATION_KEEP_EDGE_TOKENS);
	});

	test("the kept edges are a positive whole number of tokens", () => {
		expect(TRUNCATION_KEEP_EDGE_TOKENS).toBeGreaterThan(0);
		expect(Number.isInteger(TRUNCATION_KEEP_EDGE_TOKENS)).toBe(true);
	});

	test("the recovery band is hysteresis, so it sits strictly inside 0 and 1", () => {
		// At 1 the check is the raw threshold again and a pass that reclaims a
		// trickle lands just under the line every turn, which is the dead loop.
		// At 0 no pass ever counts as having recovered.
		expect(COMPACTION_RECOVERY_BAND).toBeGreaterThan(0);
		expect(COMPACTION_RECOVERY_BAND).toBeLessThan(1);
	});

	test("the idle flush outlasts the longest provider prompt-cache retention", () => {
		// Anthropic "long" retention is one hour; flushing sooner rewrites a
		// prefix the provider would still have served from cache.
		expect(PRUNE_IDLE_FLUSH_MS).toBeGreaterThan(ONE_HOUR_MS);
	});

	test("the warm suffix window is a positive token count", () => {
		expect(PRUNE_CACHE_WARM_SUFFIX_TOKENS).toBeGreaterThan(0);
	});
});

describe("what a compaction check concluded", () => {
	test("the three outcomes are distinct in the flags a caller reads", () => {
		const flags = [
			COMPACTION_CHECK_NONE,
			COMPACTION_CHECK_CONTINUATION,
			COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION,
		].map(r => `${r.continuationScheduled}/${r.automaticContinuationBlocked ?? false}`);
		expect(new Set(flags).size).toBe(3);
	});

	test("only the continuation outcome schedules one", () => {
		expect(COMPACTION_CHECK_CONTINUATION.continuationScheduled).toBe(true);
		expect(COMPACTION_CHECK_NONE.continuationScheduled).toBe(false);
		expect(COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION.continuationScheduled).toBe(false);
	});

	test("only the blocking outcome blocks the automatic one", () => {
		expect(COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION.automaticContinuationBlocked).toBe(true);
		expect(COMPACTION_CHECK_NONE.automaticContinuationBlocked).toBeUndefined();
		expect(COMPACTION_CHECK_CONTINUATION.automaticContinuationBlocked).toBeUndefined();
	});

	test("no outcome claims the history was rewritten", () => {
		// A rewrite is reported by the pass that performed one, never by a shared
		// constant, or every check would look like it had rewritten history.
		for (const result of [
			COMPACTION_CHECK_NONE,
			COMPACTION_CHECK_CONTINUATION,
			COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION,
		]) {
			expect(result.historyRewritten).toBeUndefined();
		}
	});
});

describe("the context window a model declares", () => {
	test("a stated window is used as stated", () => {
		expect(declaredContextWindow(model(200_000))).toBe(200_000);
	});

	test.each([
		["no model at all", undefined],
		["null, which states that the model never said", null],
		["undefined", undefined],
		["zero", 0],
		["a negative number", -1],
		["a string that looks like a number", "200000"],
		["NaN", Number.NaN],
	])("%s yields no window rather than a substituted default", (_label, value) => {
		const subject = value === undefined && _label === "no model at all" ? undefined : model(value);
		expect(declaredContextWindow(subject)).toBeUndefined();
	});
});

describe("a codex compaction context", () => {
	const triggers: CodexCompactionContextOptions["trigger"][] = ["manual", "auto"];
	const reasons: CodexCompactionContextOptions["reason"][] = [
		"user_requested",
		"context_limit",
		"model_downshift",
		"comp_hash_changed",
	];
	const phases: CodexCompactionContextOptions["phase"][] = ["standalone_turn", "pre_turn", "mid_turn"];
	const every: CodexCompactionContextOptions[] = triggers.flatMap(trigger =>
		reasons.flatMap(reason => phases.map(phase => ({ trigger, reason, phase }))),
	);
	const options = every[0] as CodexCompactionContextOptions;

	test("forwards every trigger, reason and phase combination unchanged", () => {
		// A member dropped or rewritten on the way through is how a compaction
		// pass gets reported to the provider as a different kind of pass.
		expect(
			every.map(createCodexCompactionContext).map(({ trigger, reason, phase }) => ({ trigger, reason, phase })),
		).toEqual(every);
	});

	test("names the one strategy this route runs", () => {
		expect(createCodexCompactionContext(options).strategy).toBe("memento");
	});

	test("identifies each operation separately, so two passes are never one", () => {
		const ids = new Set(Array.from({ length: 50 }, () => createCodexCompactionContext(options).operationId));
		expect(ids.size).toBe(50);
	});
});

describe("the dead-end notice", () => {
	test("names both ways out, since neither is something compaction can do", () => {
		const warning = compactionDeadEndWarning();
		expect(warning).toContain("/new");
		expect(warning).toContain("larger-context model");
	});
});
