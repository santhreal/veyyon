/**
 * An arm's predicted saving must come from its own settings and the run it is being
 * compared against, never from a number typed into a comment.
 *
 * WHAT THIS SUITE IS GUARDING. Every arm file states a predicted saving in its
 * header, and the run-reading procedure says to check that prediction against the
 * measured cost delta. Both copies of the number were hand-carried, so nothing
 * stopped an arm's header from disagreeing with the simulator that produced it, and
 * nothing stopped a prediction written from one workload being checked against a
 * different one. `predictArmSaving` closes both gaps by deriving the figure from the
 * parsed overlay and the baseline transcripts of the same run.
 *
 * The refusal cases matter as much as the arithmetic. A settings overlay can turn on
 * a lever this module cannot simulate, and reporting 0.0% for it would be read as
 * "measured and worthless" rather than "not measured at all".
 */

import { describe, expect, test } from "bun:test";

import { formatArmPrediction, PREFIX_AFFECTING_SETTINGS, predictArmSaving } from "./arm-prediction";
import {
	accumulatePrefixMass,
	SKIP_SIGNATURE_CHARS,
	sessionPrefixSteps,
	type TranscriptRecord,
} from "./prefix-composition";

/** An assistant turn carrying one tool call with a signature of the given length. */
const sig = (chars: number): TranscriptRecord =>
	({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1 },
			content: [{ type: "toolCall", id: "c", name: "eval", thoughtSignature: "s".repeat(chars), arguments: {} }],
		},
	}) as TranscriptRecord;

/** A billed assistant turn with no content, whose only job is to charge the prefix before it. */
const turn = (): TranscriptRecord =>
	({ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } }) as TranscriptRecord;

/** A tool result of the given size, attributed to a spillable tool. */
const result = (id: string, chars: number): TranscriptRecord =>
	({
		type: "message",
		message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "r".repeat(chars) }] },
	}) as TranscriptRecord;

/** A call that a following result can be attributed to, so the exempt-tool filter can see the name. */
const call = (id: string, name: string): TranscriptRecord =>
	({
		type: "message",
		message: { role: "assistant", usage: { input: 1 }, content: [{ type: "toolCall", id, name, arguments: {} }] },
	}) as TranscriptRecord;

/** Usage where the whole bill is prompt tokens, so a prefix share converts one-for-one. */
const allPrompt = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

function massOf(sessions: TranscriptRecord[][]) {
	let mass = accumulatePrefixMass([]);
	for (const records of sessions) mass = accumulatePrefixMass(sessionPrefixSteps(records), mass);
	return mass;
}

function predict(config: unknown, sessions: TranscriptRecord[][], usage = allPrompt) {
	return predictArmSaving("test-arm", config, sessions, massOf(sessions), usage);
}

describe("predictArmSaving — the prediction comes from the config, not from a comment", () => {
	/**
	 * A size cap is read off `context.thoughtSignatureMaxLength` and priced against
	 * the run's own prefix. The fixture is small enough to check by hand: one
	 * 5,000-character signature over a 1,000 cap, alive for one billed turn.
	 *
	 * THE DENOMINATOR IS THE WHOLE PREFIX, which is why it is 5,002 rather than
	 * 5,000. The tool call also carries two characters of `{}` arguments, and those
	 * are re-read on the same turn as the signature. Quoting a lever against only the
	 * bytes it can touch is the mistake that turns a category total into a claimed
	 * saving, so the two extra characters staying in the denominator is the behaviour
	 * under test, not noise to round away.
	 */
	test("prices a signature size cap against the whole prefix, not just the signature", () => {
		const sessions = [[sig(5000), turn()]];
		const prediction = predict({ context: { thoughtSignatureMaxLength: 1000 } }, sessions);
		expect(prediction.levers).toHaveLength(1);
		const lever = prediction.levers[0];
		expect(lever?.setting).toBe("context.thoughtSignatureMaxLength");
		expect(lever?.value).toBe(1000);
		expect(lever?.grossSaving).toBeCloseTo((5000 - SKIP_SIGNATURE_CHARS) / 5002, 10);
	});

	/**
	 * A SIZE CAP HANDS BACK NOTHING. Its verdict on a signature never changes, so the
	 * rendered prefix is byte-identical turn over turn and no cached bytes are
	 * invalidated. If this ever became non-zero the cap would have stopped being
	 * cache-stable, which is the property the whole arm rests on.
	 */
	test("reports no cache give-back for a size cap", () => {
		const prediction = predict({ context: { thoughtSignatureMaxLength: 1000 } }, [[sig(5000), turn(), turn()]]);
		expect(prediction.levers[0]?.cacheGiveBack).toBe(0);
		expect(prediction.levers[0]?.netSaving).toBe(prediction.levers[0]?.grossSaving as number);
	});

	/**
	 * A RECENCY WINDOW DOES HAND BACK, and the net is what ranks it. Reporting a
	 * window's gross saving beside a cap's would make the window look strictly better
	 * when on real data a deep one nets no more than the cap.
	 */
	test("subtracts the cache a retention window invalidates", () => {
		const sessions = [[sig(5000), sig(5000), sig(5000), turn(), turn(), turn()]];
		const prediction = predict({ context: { thoughtSignatureRetention: 1 } }, sessions);
		const lever = prediction.levers[0];
		expect(lever?.setting).toBe("context.thoughtSignatureRetention");
		expect(lever?.cacheGiveBack).toBeGreaterThan(0);
		expect(lever?.netSaving).toBeLessThan(lever?.grossSaving as number);
	});

	/**
	 * The spill threshold is stated in kilobytes in the settings and simulated in
	 * characters, and getting that conversion wrong by a factor of a thousand would
	 * make every spill arm look worthless (a 2-character cap saves nothing extra) or
	 * absurd. This pins the unit at the boundary where it is converted.
	 */
	test("reads the spill threshold as kilobytes, not characters", () => {
		const sessions = [[call("a", "eval"), result("a", 10_000), turn()]];
		const twoKb = predict({ tools: { artifactSpillThreshold: 2 } }, sessions);
		expect(twoKb.levers[0]?.grossSaving).toBeGreaterThan(0.7);
		const fiftyKb = predict({ tools: { artifactSpillThreshold: 50 } }, sessions);
		expect(fiftyKb.levers[0]?.grossSaving).toBe(0);
	});

	/**
	 * The spill lever's risk is reported in ITS OWN unit. A share of tool results is
	 * not comparable to a share of signatures without saying which, and an unlabelled
	 * percentage next to another unlabelled percentage invites exactly that.
	 */
	test("labels what each lever's given-up share is a share of", () => {
		const sessions = [[call("a", "eval"), result("a", 10_000), sig(5000), turn()]];
		const prediction = predict(
			{ context: { thoughtSignatureMaxLength: 1000 }, tools: { artifactSpillThreshold: 2 } },
			sessions,
		);
		const units = prediction.levers.map(lever => lever.contentUnit);
		expect(units).toEqual(["signatures", "tool results"]);
	});

	/**
	 * TWO LEVERS ADD, because they act on disjoint parts of the prefix, and the
	 * combined arm's headline depends on that being true rather than assumed. If they
	 * ever overlapped, this would silently double-count the intersection.
	 */
	test("sums disjoint levers into one arm total", () => {
		const sessions = [[call("a", "eval"), result("a", 10_000), sig(5000), turn()]];
		const config = { context: { thoughtSignatureMaxLength: 1000 }, tools: { artifactSpillThreshold: 2 } };
		const combined = predict(config, sessions);
		const signatureOnly = predict({ context: config.context }, sessions);
		const spillOnly = predict({ tools: config.tools }, sessions);
		expect(combined.netSaving).toBeCloseTo((signatureOnly.netSaving as number) + (spillOnly.netSaving as number), 10);
	});

	/**
	 * A PREFIX SHARE IS NOT A BILL SHARE, and this is the conversion that keeps every
	 * figure honest. The same lever on the same transcripts must predict a smaller
	 * share of the bill when output tokens are a large part of it, because the lever
	 * cannot touch output.
	 */
	test("scales the saving by what share of the bill prompt tokens are", () => {
		const sessions = [[sig(5000), turn()]];
		const config = { context: { thoughtSignatureMaxLength: 1000 } };
		const promptOnly = predict(config, sessions, allPrompt);
		const heavyOutput = predict(config, sessions, { ...allPrompt, outputTokens: 5000 });
		expect(heavyOutput.netSaving).toBeLessThan(promptOnly.netSaving);
	});
});

describe("predictArmSaving — refuses rather than reporting a confident partial number", () => {
	/**
	 * THE FAILURE THIS PREVENTS. An arm sets a prefix lever with no simulator; the
	 * module quietly contributes zero for it and returns a total that looks complete.
	 * The operator then compares a partial prediction against a full measurement and
	 * reads the difference as instrument error.
	 */
	test("names a prefix setting it cannot simulate", () => {
		const prediction = predict({ tools: { inlineOutputFloor: 0.1 } }, [[sig(5000), turn()]]);
		expect(prediction.unsimulated).toEqual(["tools.inlineOutputFloor"]);
		expect(prediction.levers).toHaveLength(0);
	});

	/**
	 * An arm whose ONLY lever is unsimulated gets a refusal, not a zero. "0.0% of
	 * bill" and "not measured" are opposite conclusions and must not render the same.
	 */
	test("refuses outright when every lever it sets is unsimulated", () => {
		const lines = formatArmPrediction(predict({ tools: { inlineOutputFloor: 0.1 } }, [[sig(5000), turn()]]));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("NO PREDICTION");
		expect(lines[0]).toContain("tools.inlineOutputFloor");
	});

	/**
	 * A partially simulatable arm still reports its measurable half, and says so
	 * FIRST. The warning is printed above the number because a reader who skips to
	 * the total is the reader it exists for.
	 */
	test("warns before the total when only part of the arm is simulated", () => {
		const lines = formatArmPrediction(
			predict({ context: { thoughtSignatureMaxLength: 1000 }, tools: { inlineOutputFloor: 0.1 } }, [
				[sig(5000), turn()],
			]),
		);
		expect(lines[0]).toContain("PARTIAL PREDICTION");
		expect(lines[0]).toContain("tools.inlineOutputFloor");
		expect(lines[1]).toContain("thoughtSignatureMaxLength");
	});

	/**
	 * Baseline sets no lever, so it gets no prediction and no warning. A control arm
	 * that reported a saving would be a straightforward bug in the comparison.
	 */
	test("predicts nothing for an arm that sets no cost lever", () => {
		const prediction = predict({ argot: { enabled: false } }, [[sig(5000), turn()]]);
		expect(prediction.levers).toHaveLength(0);
		expect(prediction.unsimulated).toHaveLength(0);
		expect(formatArmPrediction(prediction)[0]).toContain("no simulatable cost lever set");
	});

	/**
	 * A non-numeric value for a numeric lever is treated as absent rather than
	 * coerced. YAML reads a quoted "4000" as a string, and silently coercing it would
	 * predict a saving for an overlay the settings schema rejects, so the arm's own
	 * validation and its prediction would disagree about whether it is even valid.
	 */
	test("ignores a lever whose value is not a number", () => {
		const prediction = predict({ context: { thoughtSignatureMaxLength: "4000" } }, [[sig(5000), turn()]]);
		expect(prediction.levers).toHaveLength(0);
	});

	/**
	 * The unsimulated check is driven by an explicit list of prefix-affecting
	 * settings. A broad `context.*` match would flag settings that do not touch the
	 * prefix at all, and a warning that cries wolf is a warning that gets skipped.
	 */
	test("does not flag settings that have nothing to do with the prefix", () => {
		const prediction = predict({ temperature: 0, argot: { enabled: true } }, [[sig(5000), turn()]]);
		expect(prediction.unsimulated).toHaveLength(0);
	});

	/**
	 * Every setting the module claims to know about is either simulated or reported.
	 * This is the list that decides whether a new lever gets a silent zero, so it is
	 * pinned rather than left to drift as settings are added.
	 */
	test("knows which settings change the prefix", () => {
		expect(PREFIX_AFFECTING_SETTINGS).toEqual([
			"context.thoughtSignatureMaxLength",
			"context.thoughtSignatureRetention",
			"context.thinkingRetention",
			"tools.artifactSpillThreshold",
			"tools.inlineOutputFloor",
		]);
	});
});

describe("predictArmSaving — the thinking window, and why it is not a signature window", () => {
	/** An assistant turn whose thinking block is the given length. */
	const think = (chars: number): TranscriptRecord =>
		({
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 1 },
				content: [{ type: "thinking", thinking: "t".repeat(chars) }],
			},
		}) as TranscriptRecord;

	/**
	 * `context.thinkingRetention` was the last prefix lever with no simulator, so an
	 * arm setting it got a refusal rather than a number. It is simulated now, which
	 * means the only remaining refusal is `tools.inlineOutputFloor`.
	 */
	test("predicts a thinking retention window instead of refusing", () => {
		const prediction = predict({ context: { thinkingRetention: 1 } }, [[think(5000), think(5000), turn(), turn()]]);
		expect(prediction.unsimulated).toHaveLength(0);
		expect(prediction.levers[0]?.setting).toBe("context.thinkingRetention");
		expect(prediction.levers[0]?.contentUnit).toBe("thinking blocks");
	});

	/**
	 * ELIDED THINKING IS REPLACED BY NOTHING, where an elided signature is replaced
	 * by a 33-character sentinel the API requires. That asymmetry is the whole reason
	 * the two are separate lever kinds, and getting it wrong would understate every
	 * thinking figure by 33 characters per block per turn.
	 *
	 * The arithmetic: two thinking blocks then two empty turns, a one-message window.
	 * On the second block's turn one block exists and is still inside the window. On
	 * the third turn the first block has aged out. On the fourth both have. Three
	 * elisions of the FULL 5,000 characters, with nothing subtracted.
	 */
	test("credits the whole block, because nothing replaces elided thinking", () => {
		const sessions = [[think(5000), think(5000), turn(), turn()]];
		const prediction = predict({ context: { thinkingRetention: 1 } }, sessions);
		const total = 4 * 5000 + 5000; // the prefix walk over those four billed turns
		expect(prediction.levers[0]?.grossSaving).toBeCloseTo((3 * 5000) / total, 10);
	});

	/**
	 * A thinking window is a RECENCY rule, so it rewrites bytes it already sent and
	 * hands part of its saving back. Reporting its gross beside a size cap's net
	 * would make it look better than it is, which is the same error the signature
	 * windows were carrying until their give-back was measured.
	 */
	test("subtracts the cache a thinking window invalidates", () => {
		const sessions = [[think(5000), think(5000), think(5000), turn(), turn(), turn()]];
		const lever = predict({ context: { thinkingRetention: 1 } }, sessions).levers[0];
		expect(lever?.cacheGiveBack).toBeGreaterThan(0);
		expect(lever?.netSaving).toBeLessThan(lever?.grossSaving as number);
	});

	/**
	 * A thinking window must not touch signatures and a signature window must not
	 * touch thinking. They are different categories under similar names, and a lever
	 * that quietly acted on both would report a saving no shipped setting delivers.
	 */
	test("leaves signatures alone", () => {
		const sessions = [[sig(5000), sig(5000), turn(), turn()]];
		expect(predict({ context: { thinkingRetention: 1 } }, sessions).levers[0]?.grossSaving).toBe(0);
	});
});
