/**
 * The arithmetic behind every cost prediction this bench makes.
 *
 * Two mistakes are cheap to make here and both are invisible once made, which is
 * why this suite exists rather than a spot check. The first is charging a turn for
 * content that did not exist yet, which inflates whichever category the newest
 * message happened to add. The second is quoting a category's share of the PREFIX
 * as its share of the BILL, which overstates every lever by the output line's
 * share (about a sixth on real runs) and would let a lever that cannot reach a 20%
 * target look like it clears one.
 */

import { describe, expect, test } from "bun:test";

import { priceTokens, REFERENCE_RATE_CARD } from "./cost-model";
import {
	accumulatePrefixMass,
	COLLAPSED_CONVERSATION_SHARE,
	cacheEfficiency,
	cacheHitRate,
	calibratePrefix,
	conversationCollapsed,
	conversationMassPerSession,
	emptyPrefixMass,
	freshRate,
	freshTokens,
	PREFIX_CATEGORIES,
	type PrefixStep,
	predictedBillSaving,
	prefixObservations,
	prefixShares,
	prefixStability,
	rebilledCostShare,
	SIGNATURE_CAP_SWEEP,
	SKIP_SIGNATURE_CHARS,
	SPILL_SUBSTITUTION_CHARS,
	sessionPrefixSteps,
	simulateSignatureCap,
	simulateSignatureLever,
	simulateToolResultCap,
	totalPrefixMass,
} from "./prefix-composition";

describe("accumulatePrefixMass — a byte costs once per turn it survives into", () => {
	/**
	 * THE CORE CLAIM, at the smallest size where it is checkable by hand. 100
	 * characters present for three billed turns is 300 character-turns. If this
	 * were a byte census it would report 100 and every lever's value would be
	 * mis-ranked by how early in a session its bytes appear.
	 */
	test("charges a category once per billed turn it is present for", () => {
		const steps: PrefixStep[] = [
			{ kind: "grow", delta: { system: 100 } },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
		];
		const mass = accumulatePrefixMass(steps);
		expect(mass.system).toBe(300);
		expect(totalPrefixMass(mass)).toBe(300);
	});

	/**
	 * THE ORDERING BUG THIS IS BUILT TO PREVENT. The provider bills the prefix that
	 * existed BEFORE the turn it generated, so content added by that turn's own
	 * assistant message is not part of what was read. Growth after the last billed
	 * turn is therefore free, and a replay that appended first would charge it.
	 */
	test("does not charge for growth that happens after the last billed turn", () => {
		const mass = accumulatePrefixMass([
			{ kind: "grow", delta: { toolResult: 10 } },
			{ kind: "billedTurn" },
			{ kind: "grow", delta: { toolResult: 1_000_000 } },
		]);
		expect(mass.toolResult).toBe(10);
	});

	/**
	 * The same bytes are worth more the earlier they arrive, which is the entire
	 * reason for turn weighting. Here two categories contribute identical byte
	 * counts and differ fourfold in cost, so a flat census would call them equal.
	 */
	test("weights early bytes above late bytes of the same size", () => {
		const mass = accumulatePrefixMass([
			{ kind: "grow", delta: { thinking: 50 } },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
			{ kind: "grow", delta: { signature: 50 } },
			{ kind: "billedTurn" },
		]);
		expect(mass.thinking).toBe(200);
		expect(mass.signature).toBe(50);
	});

	/**
	 * Sessions must fold into one accumulator rather than being averaged as shares.
	 * Averaging per-session shares would weight a two-turn session the same as a
	 * two-hundred-turn one, and the long sessions are precisely where prefix cost
	 * concentrates, so the cheap sessions would drag the answer toward irrelevance.
	 */
	test("folds many sessions additively into one total", () => {
		const short: PrefixStep[] = [{ kind: "grow", delta: { signature: 10 } }, { kind: "billedTurn" }];
		const long: PrefixStep[] = [
			{ kind: "grow", delta: { signature: 10 } },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
			{ kind: "billedTurn" },
		];
		let total = emptyPrefixMass();
		total = accumulatePrefixMass(short, total);
		total = accumulatePrefixMass(long, total);
		expect(total.signature).toBe(60);
	});

	/** A session that never billed a turn contributes nothing, and must not throw. */
	test("returns a zeroed mass for a session with no billed turns", () => {
		const mass = accumulatePrefixMass([{ kind: "grow", delta: { system: 5000 } }]);
		expect(totalPrefixMass(mass)).toBe(0);
		for (const category of PREFIX_CATEGORIES) expect(mass[category]).toBe(0);
	});

	/** An absent category in a delta is zero growth, not an error and not NaN. */
	test("treats an omitted category as zero growth", () => {
		const mass = accumulatePrefixMass([{ kind: "grow", delta: { signature: 7 } }, { kind: "billedTurn" }]);
		expect(mass.signature).toBe(7);
		expect(mass.userText).toBe(0);
		expect(Number.isNaN(totalPrefixMass(mass))).toBe(false);
	});
});

describe("sessionPrefixSteps — reading a real transcript without charging a turn for itself", () => {
	/**
	 * THE ORDERING RULE, isolated. An assistant message is billed against the prefix
	 * that existed BEFORE it, so its own signature and thinking must not be part of
	 * what that turn paid for. Emitting the growth first would charge every turn for
	 * its own output and would inflate exactly the two categories the levers target,
	 * making both look better than they are.
	 */
	test("bills a turn against the prefix that preceded it, not including itself", () => {
		const steps = sessionPrefixSteps([
			{ type: "session_init", systemPrompt: "x".repeat(100), tools: [] },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1 },
					content: [{ type: "toolCall", thoughtSignature: "s".repeat(500), arguments: {} }],
				},
			},
		]);
		const mass = accumulatePrefixMass(steps);
		// The system prompt plus `[]` for the empty tool list; the signature this turn
		// produced is not charged, because the turn could not have read it.
		expect(mass.system).toBe(102);
		expect(mass.signature).toBe(0);
	});

	/**
	 * The same signature IS charged on the next turn, which is the whole reason it
	 * is expensive. One tool call's signature costs nothing when made and costs on
	 * every turn thereafter, so a session's late turns pay for all of its early ones.
	 */
	test("charges an earlier turn's signature on every later turn", () => {
		const assistantTurn = {
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 1 },
				content: [{ type: "toolCall", thoughtSignature: "s".repeat(500), arguments: {} }],
			},
		};
		const mass = accumulatePrefixMass(sessionPrefixSteps([assistantTurn, assistantTurn, assistantTurn]));
		// Charged on turns two and three, never on the turn that produced it.
		expect(mass.signature).toBe(500 + 500 * 2);
	});

	/**
	 * An assistant message with no `usage` was replayed rather than generated, so it
	 * cost nothing and must not bill a turn. Counting it would inflate every
	 * category by a turn that was never charged, and resumed sessions are common
	 * enough that the error would be systematic rather than rare.
	 */
	test("does not bill a turn for an assistant message that cost nothing", () => {
		const mass = accumulatePrefixMass(
			sessionPrefixSteps([
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "replayed" }] } },
				{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(50) }] } },
			]),
		);
		expect(totalPrefixMass(mass)).toBe(0);
	});

	/**
	 * Every category is picked out of the shape the transcript actually uses: tool
	 * calls carry `arguments` (not `input`), tool results arrive as role
	 * `toolResult` with `text` parts (not a `tool_result` block type), and thinking
	 * is its own block. Measuring against a guessed schema is how an earlier pass of
	 * this analysis produced two wrong compositions in a row.
	 */
	test("reads each category from the shape the transcript actually uses", () => {
		const mass = accumulatePrefixMass(
			sessionPrefixSteps([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", thoughtSignature: "sig", arguments: { a: 1 } },
							{ type: "thinking", thinking: "think" },
							{ type: "text", text: "said" },
						],
					},
				},
				{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "result" }] } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "ask" }] } },
				{ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } },
			]),
		);
		expect(mass.signature).toBe(3);
		expect(mass.arguments).toBe(JSON.stringify({ a: 1 }).length);
		expect(mass.thinking).toBe(5);
		expect(mass.assistantText).toBe(4);
		expect(mass.toolResult).toBe(6);
		expect(mass.userText).toBe(3);
	});

	/**
	 * The tool schemas sit in the prefix for the whole session exactly as the system
	 * prompt does, and no lever shrinks one without the other, so they are one
	 * figure. Splitting them would invite a prediction that elides a tool schema
	 * while leaving the prompt that documents it.
	 */
	test("folds the tool schemas into the system figure", () => {
		const tools = [{ name: "read" }, { name: "eval" }];
		const mass = accumulatePrefixMass(
			sessionPrefixSteps([
				{ type: "session_init", systemPrompt: "p", tools },
				{ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } },
			]),
		);
		expect(mass.system).toBe(1 + JSON.stringify(tools).length);
	});

	/**
	 * A record type this module has never seen contributes nothing rather than
	 * throwing. The transcript is append-only and gains record types over time, so a
	 * strict reader would turn an unrelated feature into a broken measurement tool.
	 */
	test("ignores unknown record types instead of failing on them", () => {
		const mass = accumulatePrefixMass(
			sessionPrefixSteps([
				{ type: "title" },
				{ type: "settings_snapshot" },
				{ type: "some_future_record" },
				{ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } },
			]),
		);
		expect(totalPrefixMass(mass)).toBe(0);
	});

	/** An empty transcript yields no steps and a zeroed mass, rather than throwing. */
	test("handles an empty transcript", () => {
		expect(sessionPrefixSteps([])).toEqual([]);
		expect(totalPrefixMass(accumulatePrefixMass(sessionPrefixSteps([])))).toBe(0);
	});
});

describe("prefixShares — where the re-read bytes actually are", () => {
	/** Shares are fractions of the whole and sum to one when anything was measured. */
	test("computes each category's fraction of the prefix", () => {
		const mass = accumulatePrefixMass([
			{ kind: "grow", delta: { signature: 30, toolResult: 60, system: 10 } },
			{ kind: "billedTurn" },
		]);
		const shares = prefixShares(mass);
		expect(shares.signature).toBeCloseTo(0.3, 10);
		expect(shares.toolResult).toBeCloseTo(0.6, 10);
		expect(shares.system).toBeCloseTo(0.1, 10);
		expect(PREFIX_CATEGORIES.reduce((sum, c) => sum + shares[c], 0)).toBeCloseTo(1, 10);
	});

	/**
	 * An empty measurement yields zeros, never NaN. A single NaN here propagates
	 * through every predicted saving and turns a report into a page of `NaN%`,
	 * which reads as a broken tool rather than as "no data".
	 */
	test("yields zeros rather than NaN for an empty measurement", () => {
		const shares = prefixShares(emptyPrefixMass());
		for (const category of PREFIX_CATEGORIES) expect(shares[category]).toBe(0);
	});
});

/**
 * The check that keeps every other number in this module honest.
 *
 * Everything here counts characters in a transcript, while the provider bills
 * tokens on a prompt the transcript does not fully record: tool schemas go over
 * the wire as a structured array and the session log stores only tool names. If
 * that hidden mass were large, every share would be inflated and every predicted
 * saving overstated, with nothing in the output to reveal it. Fitting what was
 * charged against what is visible measures the gap rather than assuming it away.
 */
describe("calibratePrefix — proving the character census matches what was billed", () => {
	/**
	 * THE ARITHMETIC, on points with an exact fit. Four characters per token and a
	 * 400-character fixed block that never appears in the transcript, recovered from
	 * the charges alone.
	 */
	test("recovers the tokens-per-character rate and the unseen fixed block", () => {
		const observations = [1000, 2000, 3000, 4000].map(visibleChars => ({
			visibleChars,
			promptTokens: (visibleChars + 400) / 4,
		}));
		const fit = calibratePrefix(observations);
		expect(fit?.charsPerToken).toBeCloseTo(4, 6);
		expect(fit?.unseenChars).toBeCloseTo(400, 6);
	});

	/** With nothing hidden, the intercept is zero rather than a small artefact of the fit. */
	test("reports no unseen mass when the transcript records everything", () => {
		const observations = [500, 1500, 2500].map(visibleChars => ({
			visibleChars,
			promptTokens: visibleChars / 4,
		}));
		expect(calibratePrefix(observations)?.unseenChars).toBeCloseTo(0, 6);
	});

	/**
	 * THE MEASURED CASE, reproduced from the twenty-session baseline: 3.88 characters
	 * per token and about 6,000 characters unseen, which adds 1.3% to the prefix
	 * total and moves the signature lever's prediction by two tenths of a point. The
	 * assertion is deliberately a RANGE on the rate, because the point is that it
	 * lands in the normal band for prose and code. A figure well below it would mean
	 * real prefix mass is missing from the fit and every share in this module is
	 * inflated.
	 */
	test("lands in the normal chars-per-token band on realistic data", () => {
		const observations = [];
		for (let turn = 1; turn <= 50; turn++) {
			const visibleChars = 80_000 + turn * 9000;
			observations.push({ visibleChars, promptTokens: Math.round((visibleChars + 6000) / 3.88) });
		}
		const fit = calibratePrefix(observations);
		expect(fit?.charsPerToken).toBeGreaterThan(3.5);
		expect(fit?.charsPerToken).toBeLessThan(4.5);
		expect(fit?.unseenChars).toBeGreaterThan(4000);
		expect(fit?.unseenChars).toBeLessThan(8000);
	});

	/**
	 * A slope through one point is not a calibration, and a run where every turn
	 * shows the same visible size cannot separate the slope from the intercept.
	 * Returning null there is the honest answer; inventing a number would put a
	 * fabricated validation next to real measurements, which is worse than printing
	 * nothing.
	 */
	test("refuses to fit fewer than two points or a degenerate spread", () => {
		expect(calibratePrefix([])).toBeNull();
		expect(calibratePrefix([{ visibleChars: 1000, promptTokens: 250 }])).toBeNull();
		expect(
			calibratePrefix([
				{ visibleChars: 1000, promptTokens: 250 },
				{ visibleChars: 1000, promptTokens: 260 },
			]),
		).toBeNull();
	});

	/** A negative or zero slope is not a coherent token rate, so it is refused rather than reported. */
	test("refuses a fit that implies tokens shrink as the prompt grows", () => {
		expect(
			calibratePrefix([
				{ visibleChars: 1000, promptTokens: 500 },
				{ visibleChars: 2000, promptTokens: 250 },
			]),
		).toBeNull();
	});
});

describe("prefixObservations — the calibration walks the same transcript as the census", () => {
	const billedTurn = (promptTokens: number) => ({
		type: "message",
		message: { role: "assistant", usage: { input: promptTokens }, content: [] },
	});
	const toolResult = (size: number) => ({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(size) }] },
	});

	/**
	 * Each observation pairs a turn's charge with the prefix that PRECEDED it, the
	 * same ordering the mass accounting uses. A calibration computed against a
	 * different walk of the transcript would validate nothing, so the two share the
	 * step replay rather than each reading the records themselves.
	 */
	test("pairs each charge with the prefix that preceded that turn", () => {
		const observations = prefixObservations([
			{ type: "session_init", systemPrompt: "s".repeat(1000), tools: [] },
			billedTurn(300),
			toolResult(500),
			billedTurn(430),
		]);
		expect(observations).toEqual([
			{ visibleChars: 1002, promptTokens: 300 },
			{ visibleChars: 1502, promptTokens: 430 },
		]);
	});

	/** Cache reads and writes are prompt tokens too, so all three lines are summed. */
	test("counts cache reads and writes as part of the charged prompt", () => {
		const observations = prefixObservations([
			{ type: "session_init", systemPrompt: "s".repeat(100), tools: [] },
			{
				type: "message",
				message: { role: "assistant", usage: { input: 10, cacheRead: 20, cacheWrite: 5 }, content: [] },
			},
		]);
		expect(observations[0]?.promptTokens).toBe(35);
	});

	/**
	 * A turn with no recorded prompt tokens is skipped, not folded in as zero. An
	 * absent count is unknown, and a zero would drag the fitted line toward a
	 * fabricated origin and understate the unseen block.
	 */
	test("skips a turn with no recorded prompt tokens rather than treating it as zero", () => {
		const observations = prefixObservations([
			{ type: "session_init", systemPrompt: "s".repeat(100), tools: [] },
			{ type: "message", message: { role: "assistant", usage: { output: 50 }, content: [] } },
			billedTurn(40),
		]);
		expect(observations).toEqual([{ visibleChars: 102, promptTokens: 40 }]);
	});

	/** A transcript with no billed turns yields no observations, and must not throw. */
	test("returns nothing for a transcript with no billed turns", () => {
		expect(prefixObservations([{ type: "message", message: { role: "toolResult", content: [] } }])).toEqual([]);
	});
});

describe("simulateToolResultCap — a category total is not a lever's reach", () => {
	/** A billed turn whose only job is to charge the prefix that precedes it. */
	const billedTurn = { type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } };
	const toolResult = (size: number) => ({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(size) }] },
	});

	/**
	 * THE ARITHMETIC, at a size checkable by hand. A 1000-character result present
	 * for two billed turns, capped at 400, removes its 600-character overflow twice,
	 * less the marker and footer that replace it on each of those turns.
	 *
	 * The subtraction is the point and it is why this reads as an odd number. A spill
	 * does not delete the overflow, it substitutes `[…NNNln elided…]` and
	 * `[raw output: artifact://<id>]`, and those characters are re-read on every later
	 * turn exactly as the elided ones would have been. This test asserted the
	 * un-netted 1200 for as long as the simulation credited the whole overflow, which
	 * is precisely how an optimistic prediction survives having a test.
	 */
	test("removes the excess above the cap net of what replaces it, once per turn it survives", () => {
		const { removed, total } = simulateToolResultCap([toolResult(1000), billedTurn, billedTurn], 400);
		expect(removed).toBe(2 * (600 - SPILL_SUBSTITUTION_CHARS));
		expect(total).toBe(2000);
	});

	/**
	 * A RESULT BARELY OVER THE THRESHOLD IS NOT A SAVING, it is a small loss, and the
	 * simulation reports zero rather than a negative number.
	 *
	 * Spilling a result whose overflow is smaller than the marker plus footer puts
	 * MORE on the wire than sending it whole. Crediting the negative would be worse
	 * than wrong in a single case: summed over a sweep it would let a tight threshold
	 * borrow saving from the very results it makes more expensive, so the threshold
	 * that looked best would be the one that harmed the most results.
	 */
	test("credits nothing for a result whose overflow is smaller than the substitution", () => {
		const barelyOver = 400 + SPILL_SUBSTITUTION_CHARS - 1;
		expect(simulateToolResultCap([toolResult(barelyOver), billedTurn], 400).removed).toBe(0);
	});

	/**
	 * The substitution is MEASURED FROM THE SHIPPED FUNCTIONS, not pasted here as a
	 * number. If it were pasted, the test and the simulation could agree with each
	 * other while both disagreed with what the agent actually writes, which is the
	 * failure mode the whole module exists to avoid. The bound is loose on purpose:
	 * it pins the order of magnitude so a mistake like counting bytes per character
	 * or dropping the footer entirely fails, without re-encoding either string.
	 */
	test("prices the substitution from the marker and footer the agent really emits", () => {
		expect(SPILL_SUBSTITUTION_CHARS).toBeGreaterThan(30);
		expect(SPILL_SUBSTITUTION_CHARS).toBeLessThan(80);
	});

	/** A result already under the cap costs its full size and saves nothing. */
	test("saves nothing on results below the cap", () => {
		const { removed, total } = simulateToolResultCap([toolResult(100), billedTurn], 50_000);
		expect(removed).toBe(0);
		expect(total).toBe(100);
	});

	/**
	 * THE FINDING THIS FUNCTION EXISTS TO EXPRESS, in miniature. Tool results are
	 * the whole prefix here, yet a cap set above every individual result saves
	 * nothing at all. Reading "tool results are 26% of the prefix" as "a size cap is
	 * worth 26%" is exactly this mistake at scale: on the real baseline the shipped
	 * 50KB threshold reaches 0.6% of the prefix, not 26%, because the mass is spread
	 * across many mid-sized results rather than a few giants.
	 */
	test("shows a large category with no large individual results is unreachable by a cap", () => {
		const records = [];
		for (let i = 0; i < 20; i++) records.push(toolResult(1000), billedTurn);
		const { removed, total } = simulateToolResultCap(records, 5000);
		expect(total).toBeGreaterThan(0);
		expect(removed).toBe(0);
	});

	/**
	 * A tighter cap reaches strictly further, which is the monotonicity the sweep
	 * over thresholds depends on. If this were not true, comparing two candidate
	 * floors would be meaningless.
	 */
	test("is monotone: a tighter cap never saves less", () => {
		const records = [toolResult(500), billedTurn, toolResult(9000), billedTurn, toolResult(30_000), billedTurn];
		const savings = [50_000, 20_000, 10_000, 5000, 1000].map(cap => simulateToolResultCap(records, cap).removed);
		for (let i = 1; i < savings.length; i++) {
			expect(savings[i] as number).toBeGreaterThanOrEqual(savings[i - 1] as number);
		}
	});

	/**
	 * The total is the WHOLE prefix, not just the tool-result part, because the
	 * saving has to be quoted against everything the provider re-reads. Dividing by
	 * the tool-result mass alone would inflate the number by roughly four times on
	 * real data.
	 */
	test("measures the saving against the whole prefix, not just tool results", () => {
		const { total } = simulateToolResultCap(
			[{ type: "session_init", systemPrompt: "s".repeat(900), tools: [] }, toolResult(100), billedTurn],
			50,
		);
		expect(total).toBe(1002);
	});

	/** An empty transcript yields zeros rather than NaN from a division downstream. */
	test("returns zeros for an empty transcript", () => {
		expect(simulateToolResultCap([], 1000)).toEqual({ removed: 0, total: 0, spilled: 0, results: 0 });
	});

	/**
	 * THE SPILL RATE IS THE RISK HALF OF THE TRADE, and it is counted per RESULT
	 * rather than per turn: a result that spills is one piece of content the model
	 * must spend a turn recovering, however many turns it then sits in the prefix.
	 *
	 * Without this the sweep reported only what a threshold saves, and the arm file
	 * for the tightest threshold described its own exposure as "a large share of
	 * ordinary eval output" with no figure behind it. The signature sweep has printed
	 * its equivalent from the start, which is what made the omission visible.
	 */
	test("counts how many results spill, once each, alongside how much they save", () => {
		const records = [toolResult(5000), billedTurn, toolResult(100), billedTurn, toolResult(9000), billedTurn];
		const sim = simulateToolResultCap(records, 2000);
		expect(sim.results).toBe(3);
		expect(sim.spilled).toBe(2);
	});

	/** A threshold above every result spills none of them, so the rate is zero, not undefined. */
	test("reports no spills when the threshold is above every result", () => {
		const sim = simulateToolResultCap([toolResult(1000), billedTurn], 50_000);
		expect(sim.results).toBe(1);
		expect(sim.spilled).toBe(0);
	});
});

describe("predictedBillSaving — prefix share is not bill share", () => {
	/**
	 * THE MEASURED CASE, reproduced from the twenty-session DeepSWE baseline:
	 * 23,667,983 fresh input tokens, 265,495,383 cache reads, no cache writes, and
	 * 1,832,066 output tokens. Those price to 85.5% prompt and 14.5% output, so a
	 * lever removing the full signature category buys 37.4% x 85.5% = 32.0% of the
	 * bill. This is the number the 20% target is judged against, so it is pinned
	 * against the real token counts rather than against round ones.
	 */
	test("scales a 37.4% prefix category down to its true share of the bill", () => {
		const cost = priceTokens({
			inputTokens: 23_667_983,
			cacheReadTokens: 265_495_383,
			cacheWriteTokens: 0,
			outputTokens: 1_832_066,
		});
		const mass = accumulatePrefixMass([
			{ kind: "grow", delta: { signature: 374, toolResult: 626 } },
			{ kind: "billedTurn" },
		]);
		const saving = predictedBillSaving(mass, ["signature"], cost);
		expect(saving).toBeGreaterThan(0.31);
		expect(saving).toBeLessThan(0.33);
		// And the unscaled prefix share, which is the number it must NOT report.
		expect(prefixShares(mass).signature).toBeCloseTo(0.374, 10);
	});

	/**
	 * The scaling is not cosmetic. On the same data the naive answer overstates by
	 * more than five points of bill, which is the difference between a lever that
	 * clears a 20% target and one that is merely close, so the two numbers are
	 * asserted apart rather than approximately equal.
	 */
	test("reports materially less than the raw prefix share", () => {
		const cost = priceTokens({
			inputTokens: 23_667_983,
			cacheReadTokens: 265_495_383,
			cacheWriteTokens: 0,
			outputTokens: 1_832_066,
		});
		const mass = accumulatePrefixMass([
			{ kind: "grow", delta: { signature: 374, toolResult: 626 } },
			{ kind: "billedTurn" },
		]);
		const naive = prefixShares(mass).signature;
		expect(naive - predictedBillSaving(mass, ["signature"], cost)).toBeGreaterThan(0.05);
	});

	/**
	 * Combining levers adds their prefix shares before scaling once. Scaling each
	 * separately and then adding gives the same answer here, but stacking the
	 * categories in one call is how the report asks the question, so the additive
	 * behaviour is pinned rather than assumed.
	 */
	test("adds the shares of several elided categories before scaling", () => {
		const cost = priceTokens({
			inputTokens: 0,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 0,
			outputTokens: 0,
		});
		const mass = accumulatePrefixMass([
			{ kind: "grow", delta: { signature: 374, thinking: 90, toolResult: 536 } },
			{ kind: "billedTurn" },
		]);
		// An all-prompt bill, so the prefix share passes through unscaled.
		expect(predictedBillSaving(mass, ["signature", "thinking"], cost)).toBeCloseTo(0.464, 10);
	});

	/**
	 * THE CEILING, stated as a test so nobody has to trust the doc comment. If the
	 * entire bill were output tokens, no amount of prefix elision would save a
	 * cent. This is the degenerate end of the same arithmetic that makes the
	 * measured case 32% rather than 37.4%.
	 */
	test("predicts exactly zero when the whole bill is output", () => {
		const cost = priceTokens({
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 1_000_000,
		});
		const mass = accumulatePrefixMass([{ kind: "grow", delta: { signature: 1000 } }, { kind: "billedTurn" }]);
		expect(predictedBillSaving(mass, ["signature"], cost)).toBe(0);
	});

	/**
	 * Cache writes pay for the same prefix, so a smaller prefix writes less and the
	 * line belongs in the scaling. Gemini reports no cache writes at all on these
	 * runs, so this branch is unexercised by real data and would rot silently on a
	 * provider that does bill them.
	 */
	test("counts cache writes as a prompt line, not as output", () => {
		const cost = priceTokens({
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 1_000_000,
			outputTokens: 0,
		});
		const mass = accumulatePrefixMass([{ kind: "grow", delta: { signature: 1000 } }, { kind: "billedTurn" }]);
		expect(predictedBillSaving(mass, ["signature"], cost)).toBe(1);
	});

	/** Eliding nothing saves nothing, and an empty measurement predicts nothing. */
	test("predicts zero for an empty elision set or an empty measurement", () => {
		const cost = priceTokens({
			inputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
		});
		const mass = accumulatePrefixMass([{ kind: "grow", delta: { signature: 1000 } }, { kind: "billedTurn" }]);
		expect(predictedBillSaving(mass, [], cost)).toBe(0);
		expect(predictedBillSaving(emptyPrefixMass(), ["signature"], cost)).toBe(0);
	});
});

/**
 * The only lever here that cannot cost reward.
 *
 * Every other measurement in this file sizes something you would REMOVE from the
 * context, and removing context risks the model's behaviour. This one removes
 * nothing: the same bytes reach the model either way, and only the rate they are
 * billed at changes. On the twenty-session baseline the median turn is charged 6.5
 * times more uncached input than the content it actually added, and paying the
 * fresh rate on those re-reads costs 14.0% of the bill for nothing.
 *
 * The estimate has to stay conservative in one specific direction, and these tests
 * pin that: a turn that genuinely added a lot must be CREDITED for it, or the
 * measurement inflates itself by calling ordinary new content waste.
 */
describe("cacheEfficiency — content the provider already had, billed as if it were new", () => {
	const CPT = 4;
	const turn = (input: number, cacheRead: number, cacheWrite = 0) => ({
		type: "message",
		message: { role: "assistant", usage: { input, cacheRead, cacheWrite }, content: [] },
	});
	const toolResult = (chars: number) => ({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(chars) }] },
	});

	/**
	 * A PERFECT CACHE bills exactly the new content at the fresh rate and nothing
	 * more. Here 400 characters of new content is 100 tokens, and 100 fresh tokens
	 * are charged, so nothing was re-read.
	 */
	test("reports no waste when fresh billing matches the content added", () => {
		const efficiency = cacheEfficiency(
			[
				// 398 characters plus the `[]` of an empty tool list is 400, exactly 100
				// tokens at this rate, so the first turn's fresh billing matches it with no
				// fencepost slack to hide behind.
				{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] },
				turn(100, 0),
				toolResult(400),
				turn(100, 100),
			],
			CPT,
		);
		expect(efficiency.rebilledTokens).toBe(0);
		expect(efficiency.newContentTokens).toBe(200);
	});

	/**
	 * THE MEASURED FAILURE, in miniature. The turn added 400 characters, 100 tokens,
	 * and was billed 1,000 fresh tokens. The 900-token excess is content the
	 * provider had already been sent and re-read at four times its cached price.
	 */
	test("counts fresh billing beyond the content added as re-read", () => {
		const efficiency = cacheEfficiency(
			[
				{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] },
				turn(100, 0),
				toolResult(400),
				turn(1000, 50_000),
			],
			CPT,
		);
		expect(efficiency.rebilledTokens).toBe(900);
		expect(efficiency.cachedTokens).toBe(50_000);
		expect(efficiency.uncachedTokens).toBe(1100);
	});

	/**
	 * THE DIRECTION THAT MUST NOT BE GOT WRONG. A turn that genuinely added a huge
	 * tool result is credited for it in full, so a legitimately expensive turn is
	 * never counted as waste. An estimate that inflated itself here would make a
	 * cache lever look large on a workload that simply produces a lot of output.
	 */
	test("credits a turn that really did add a lot, rather than calling it waste", () => {
		const efficiency = cacheEfficiency(
			[
				{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] },
				turn(100, 0),
				toolResult(400_000),
				turn(50_000, 1000),
			],
			CPT,
		);
		expect(efficiency.rebilledTokens).toBe(0);
		expect(efficiency.newContentTokens).toBe(50_100);
	});

	/**
	 * New content is capped by what was actually billed fresh, so a cache that
	 * somehow served MORE than the new content cannot produce a negative waste
	 * figure or a new-content total above the fresh line. Both would be nonsense in
	 * a report and neither can happen silently.
	 */
	test("never reports negative waste or more new content than was billed fresh", () => {
		const efficiency = cacheEfficiency(
			[
				{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] },
				turn(100, 0),
				toolResult(400_000),
				turn(10, 99_000),
			],
			CPT,
		);
		expect(efficiency.rebilledTokens).toBe(0);
		expect(efficiency.newContentTokens).toBeLessThanOrEqual(efficiency.uncachedTokens);
	});

	/** A transcript with no billed turns measures nothing, and must not throw or divide by zero. */
	test("returns zeros for a transcript with no billed turns", () => {
		expect(cacheEfficiency([toolResult(500)], CPT)).toEqual({
			uncachedTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
			newContentTokens: 0,
			rebilledTokens: 0,
		});
	});

	/**
	 * A CACHE WRITE IS FRESH BILLING, NOT A HIT, and this is the test that stops the
	 * measurement from lying about it. The turn added 400 characters, 100 tokens, and
	 * was billed 1,000 tokens as a WRITE with no plain input at all. Those thousand
	 * tokens cost more per token than input, so the 900-token excess is exactly as
	 * wasteful as it would have been on the input line. An earlier version of this
	 * function counted writes as cache hits, which reported this turn as a perfect
	 * cache with zero waste.
	 */
	test("counts a cache write as fresh billing, so a write beyond the content added is waste", () => {
		const efficiency = cacheEfficiency(
			[
				{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] },
				turn(0, 0, 100),
				toolResult(400),
				turn(0, 0, 1000),
			],
			CPT,
		);
		expect(efficiency.cacheWriteTokens).toBe(1100);
		expect(efficiency.uncachedTokens).toBe(0);
		expect(efficiency.rebilledTokens).toBe(900);
	});

	/**
	 * WHY THE SPLIT MATTERS FOR COMPARING PROVIDERS, which is the reason it was
	 * introduced. These two turns bill the identical number of fresh tokens against
	 * the identical cache reads. One provider routes the fresh tokens through plain
	 * input, as an implicit cache does; the other routes them through a write, as a
	 * moving explicit breakpoint does. The hit rate is the same for both, correctly,
	 * and the split still records which line was charged, so the price difference
	 * between the two designs stays visible instead of averaging away.
	 */
	test("keeps input and write apart while giving both the same hit rate", () => {
		const viaInput = cacheEfficiency(
			[{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] }, turn(100, 900)],
			CPT,
		);
		const viaWrite = cacheEfficiency(
			[{ type: "session_init", systemPrompt: "s".repeat(398), tools: [] }, turn(0, 900, 100)],
			CPT,
		);
		expect(cacheHitRate(viaInput)).toBe(0.9);
		expect(cacheHitRate(viaWrite)).toBe(0.9);
		expect(freshTokens(viaInput)).toBe(freshTokens(viaWrite));
		expect(viaInput.cacheWriteTokens).toBe(0);
		expect(viaWrite.uncachedTokens).toBe(0);
	});
});

describe("cacheHitRate — writes belong in the denominator and nowhere else", () => {
	const eff = (uncachedTokens: number, cachedTokens: number, cacheWriteTokens: number) => ({
		uncachedTokens,
		cachedTokens,
		cacheWriteTokens,
		newContentTokens: 0,
		rebilledTokens: 0,
	});

	/**
	 * THE BUG THIS EXISTS TO PREVENT, stated as arithmetic. A run that served nothing
	 * from cache and wrote the entire prompt has a hit rate of ZERO. Folding writes
	 * into the numerator would call it a flawless 100% cache while every token was
	 * billed above the input rate.
	 */
	test("reports zero for a run that only ever wrote the cache", () => {
		expect(cacheHitRate(eff(0, 0, 1_000_000))).toBe(0);
	});

	/** A run entirely served from cache is a full hit rate, the opposite bound. */
	test("reports one for a run served entirely from cache", () => {
		expect(cacheHitRate(eff(0, 1_000_000, 0))).toBe(1);
	});

	/** Writes push the rate DOWN because they enlarge the denominator alone. */
	test("falls when writes are added to an otherwise unchanged run", () => {
		expect(cacheHitRate(eff(100, 900, 0))).toBe(0.9);
		expect(cacheHitRate(eff(100, 900, 1000))).toBe(0.45);
	});

	/** A run with no prompt tokens at all reports zero rather than NaN. */
	test("reports zero rather than NaN when nothing was billed", () => {
		expect(cacheHitRate(eff(0, 0, 0))).toBe(0);
	});
});

describe("freshRate — a re-read is priced against the line it was actually billed on", () => {
	/** All-input fresh billing is priced at exactly the input rate. */
	test("is the input rate when no writes were billed", () => {
		expect(
			freshRate(
				{ uncachedTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, newContentTokens: 0, rebilledTokens: 0 },
				REFERENCE_RATE_CARD,
			),
		).toBe(REFERENCE_RATE_CARD.input);
	});

	/** All-write fresh billing is priced at the write rate, which is the HIGHER of the two. */
	test("is the write rate when every fresh token was a write", () => {
		expect(
			freshRate(
				{ uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 1000, newContentTokens: 0, rebilledTokens: 0 },
				REFERENCE_RATE_CARD,
			),
		).toBe(REFERENCE_RATE_CARD.cacheWrite);
		expect(REFERENCE_RATE_CARD.cacheWrite).toBeGreaterThan(REFERENCE_RATE_CARD.input);
	});

	/** A half-and-half mix lands on the midpoint of the two rates, weighted by token count. */
	test("blends the two rates in proportion to the tokens billed on each", () => {
		const blended = freshRate(
			{ uncachedTokens: 1000, cachedTokens: 0, cacheWriteTokens: 1000, newContentTokens: 0, rebilledTokens: 0 },
			REFERENCE_RATE_CARD,
		);
		expect(blended).toBeCloseTo((REFERENCE_RATE_CARD.input + REFERENCE_RATE_CARD.cacheWrite) / 2, 12);
	});

	/** With nothing billed fresh there is no mix to weight, so it falls back to the input rate rather than dividing by zero. */
	test("falls back to the input rate when nothing was billed fresh", () => {
		expect(
			freshRate(
				{ uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, newContentTokens: 0, rebilledTokens: 0 },
				REFERENCE_RATE_CARD,
			),
		).toBe(REFERENCE_RATE_CARD.input);
	});
});

describe("rebilledCostShare — the saving is the rate difference, not the whole line", () => {
	/**
	 * THE ARITHMETIC THAT KEEPS THIS HONEST. Re-read tokens still have to be sent;
	 * they would simply be billed as cache reads. So the saving is the difference
	 * between the two rates, $0.225 per million at the reference card, NOT the whole
	 * fresh-input line. Quoting the line would overstate the lever fourfold, which
	 * is the same error as quoting a prefix share as a bill share.
	 */
	test("prices the gap between the fresh and cached rates", () => {
		const cost = priceTokens({
			inputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
		});
		const share = rebilledCostShare(
			{
				uncachedTokens: 1_000_000,
				cachedTokens: 0,
				cacheWriteTokens: 0,
				newContentTokens: 0,
				rebilledTokens: 1_000_000,
			},
			cost,
			REFERENCE_RATE_CARD,
		);
		// $0.225 overpaid against a $0.30 bill.
		expect(share).toBeCloseTo(0.75, 10);
	});

	/**
	 * THE SAME RE-READ COSTS MORE WHEN IT WAS BILLED AS A WRITE, and the pricing has
	 * to say so. A million re-read tokens charged at the write rate overpay against
	 * the cached rate by more than the same million charged as input, because the
	 * write rate is the higher of the two. Pricing every re-read at the input rate
	 * would understate the waste on exactly the provider that writes its cache every
	 * turn, which is the provider this split was added to measure.
	 */
	test("prices a re-read billed as a write above the same re-read billed as input", () => {
		const cost = priceTokens({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0 });
		const asWrite = rebilledCostShare(
			{
				uncachedTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 1_000_000,
				newContentTokens: 0,
				rebilledTokens: 1_000_000,
			},
			cost,
			REFERENCE_RATE_CARD,
		);
		// The overpay is write minus cacheRead, $0.3083, against a $0.3833 bill.
		expect(asWrite).toBeCloseTo(
			(REFERENCE_RATE_CARD.cacheWrite - REFERENCE_RATE_CARD.cacheRead) / REFERENCE_RATE_CARD.cacheWrite,
			10,
		);
		const asInput = rebilledCostShare(
			{
				uncachedTokens: 1_000_000,
				cachedTokens: 0,
				cacheWriteTokens: 0,
				newContentTokens: 0,
				rebilledTokens: 1_000_000,
			},
			priceTokens({ inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
			REFERENCE_RATE_CARD,
		);
		// Same token count, more dollars overpaid, because the line it was billed on is dearer.
		expect(1_000_000 * (REFERENCE_RATE_CARD.cacheWrite - REFERENCE_RATE_CARD.cacheRead)).toBeGreaterThan(
			1_000_000 * (REFERENCE_RATE_CARD.input - REFERENCE_RATE_CARD.cacheRead),
		);
		// And a larger share of the bill, not just more dollars: the write rate is
		// further above the cached rate than the input rate is, so a run whose fresh
		// tokens go through writes is wasting proportionally more of what it spends.
		expect(asWrite).toBeGreaterThan(asInput);
	});

	/**
	 * THE MEASURED CASE, from the twenty-session baseline: 19.7M re-read tokens
	 * against a $31.59 bill lands at 14.0%. Pinned against the real figures so a
	 * change to the rate card or the arithmetic has to restate the headline rather
	 * than move it quietly.
	 */
	test("reproduces the 14% figure from the measured baseline", () => {
		const cost = priceTokens({
			inputTokens: 23_667_983,
			cacheReadTokens: 265_495_383,
			cacheWriteTokens: 0,
			outputTokens: 1_832_066,
		});
		const share = rebilledCostShare(
			{
				uncachedTokens: 23_667_983,
				cachedTokens: 265_495_383,
				// Gemini's implicit cache never charges a write, so splitting writes out
				// of the hit count leaves this measured headline exactly where it was.
				cacheWriteTokens: 0,
				newContentTokens: 3_944_750,
				rebilledTokens: 19_723_233,
			},
			cost,
			REFERENCE_RATE_CARD,
		);
		expect(share).toBeGreaterThan(0.135);
		expect(share).toBeLessThan(0.145);
	});

	/** A run with no waste, or no bill at all, reports zero rather than NaN. */
	test("reports zero for a perfect cache and for an empty bill", () => {
		const cost = priceTokens({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
		const perfect = {
			uncachedTokens: 100,
			cachedTokens: 0,
			cacheWriteTokens: 0,
			newContentTokens: 100,
			rebilledTokens: 0,
		};
		expect(rebilledCostShare(perfect, cost, REFERENCE_RATE_CARD)).toBe(0);
		const empty = priceTokens({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
		expect(rebilledCostShare(perfect, empty, REFERENCE_RATE_CARD)).toBe(0);
	});
});

/**
 * Whether a lever's predicted saving survives contact with the prefix cache.
 *
 * WHY THIS SUITE DECIDES WHETHER A LEVER SHIPS. Every other prediction in this
 * module assumes elided bytes simply stop being sent. That holds only if the rest
 * of the prefix still renders byte-identically to the previous turn: a cache
 * matches a leading run of bytes, so ONE rewritten character in the middle of the
 * history costs everything after it at the fresh rate, which this bench measures at
 * four times the cached rate. A lever can therefore remove a fifth of the prefix and
 * still lose money, and nothing else in this file would notice.
 *
 * The two shipped levers differ exactly here, and not in a way their descriptions
 * reveal. A size cap decides per signature by its own length, which never changes,
 * so the prefix is byte-stable. A recency window decides by distance from the end,
 * which moves every turn, so it rewrites bytes it already sent.
 */
describe("prefixStability — a lever that rewrites history hands its saving back", () => {
	const sig = (chars: number, argChars = 0) => ({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1 },
			content: [{ type: "toolCall", thoughtSignature: "s".repeat(chars), arguments: { a: "x".repeat(argChars) } }],
		},
	});
	const result = (chars: number) => ({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: "r".repeat(chars) }] },
	});

	/**
	 * THE CONTROL. Sending everything never rewrites anything, so a stock session is
	 * perfectly cache-stable. If this ever reported instability the measurement would
	 * be detecting its own replay rather than a lever.
	 */
	test("reports a stock session as perfectly stable", () => {
		const stability = prefixStability([sig(5000), result(100), sig(5000), result(100), sig(5000)], {
			kind: "stock",
		});
		expect(stability.comparisons).toBe(2);
		expect(stability.stableComparisons).toBe(2);
		expect(stability.invalidatedCharTurns).toBe(0);
	});

	/**
	 * THE PROPERTY THAT MAKES A SIZE CAP SHIPPABLE. A signature's length is fixed for
	 * the life of the session, so the cap's verdict on it never changes and the
	 * rendered prefix is byte-identical turn over turn. This is the guarantee that
	 * lets the 22.7% prediction be quoted as a real saving rather than an upper bound
	 * that the cache claws back.
	 */
	test("a size cap never rewrites history, whatever it elides", () => {
		const records = [sig(50_000), result(100), sig(10), result(100), sig(50_000), result(100), sig(10)];
		const stability = prefixStability(records, { kind: "sizeCap", maxLength: 4000 });
		expect(stability.comparisons).toBe(3);
		expect(stability.stableComparisons).toBe(3);
		expect(stability.rewrittenSignatureChars).toBe(0);
		expect(stability.invalidatedCharTurns).toBe(0);
	});

	/**
	 * THE PROPERTY THAT MAKES A RECENCY WINDOW SUSPECT. The boundary moves forward
	 * every turn, so a signature retained on one turn becomes history on the next and
	 * is replaced by the sentinel. That is a rewrite of bytes already sent, and it
	 * happens on essentially every turn rather than occasionally.
	 */
	test("a recency window rewrites history on turn after turn", () => {
		const records = [sig(5000), result(100), sig(5000), result(100), sig(5000), result(100), sig(5000)];
		const stability = prefixStability(records, { kind: "retainLast", assistantMessages: 1 });
		expect(stability.comparisons).toBe(3);
		// The first comparison has only one historical signature and it is still the
		// most recent, so nothing has moved out of the window yet.
		expect(stability.stableComparisons).toBeLessThan(stability.comparisons);
		expect(stability.rewrittenSignatureChars).toBeGreaterThan(0);
	});

	/**
	 * THE DISTINCTION THE WHOLE MEASUREMENT EXISTS FOR: a rewrite costs everything
	 * AFTER it, not itself. Here one 5,000-character signature is rewritten and a
	 * 100,000-character tool result sits behind it, so the invalidated tail is far
	 * larger than the rewritten bytes. Counting only what changed would understate
	 * the damage by more than twentyfold and would have made a ruinous lever look
	 * cheap.
	 */
	test("charges the whole tail behind a rewrite, not just the bytes that changed", () => {
		const records = [sig(5000), result(100_000), sig(5000), result(100_000), sig(5000)];
		const stability = prefixStability(records, { kind: "retainLast", assistantMessages: 1 });
		expect(stability.invalidatedCharTurns).toBeGreaterThan(100_000);
		expect(stability.invalidatedCharTurns).toBeGreaterThan(stability.rewrittenSignatureChars * 20);
	});

	/**
	 * A DEEPER WINDOW INVALIDATES MORE, which is the mechanism stated as a
	 * monotonicity. Retaining more recent messages pushes the moving boundary further
	 * back into the conversation, so more of the prefix sits behind the rewrite. The
	 * measured baseline shows the same ordering: 1.1% of prefix invalidated at K=1
	 * against 5.9% at K=5.
	 */
	test("invalidates more of the prefix as the retained window deepens", () => {
		// Long enough that a five-message window actually pushes signatures out of it.
		// A short session never reaches the deeper boundary and would report zero for
		// both windows, which says nothing about the ordering under test.
		const records = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? sig(5000) : result(20_000)));
		const shallow = prefixStability(records, { kind: "retainLast", assistantMessages: 1 });
		const deep = prefixStability(records, { kind: "retainLast", assistantMessages: 5 });
		expect(deep.invalidatedCharTurns).toBeGreaterThan(shallow.invalidatedCharTurns);
	});

	/**
	 * A session with a single billed turn has nothing to compare against, so it
	 * reports no comparisons rather than inventing a stable one. Counting it as
	 * stable would let a run of one-turn sessions certify any lever as cache-safe.
	 */
	test("reports no comparisons for a session with a single billed turn", () => {
		const stability = prefixStability([sig(5000)], { kind: "retainLast", assistantMessages: 1 });
		expect(stability.comparisons).toBe(0);
		expect(stability.stableComparisons).toBe(0);
		expect(stability.invalidatedCharTurns).toBe(0);
	});

	/**
	 * An unbilled assistant message was replayed rather than generated, so it is not a
	 * turn and must not be compared. Its content still enters the prefix, because the
	 * next real turn does have to send it.
	 */
	test("does not compare against an assistant message that cost nothing", () => {
		const replayed = {
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "replayed" }] },
		};
		const stability = prefixStability([sig(5000), replayed, sig(5000)], { kind: "stock" });
		expect(stability.comparisons).toBe(1);
	});
});

/**
 * The cap simulation only counts tools the shipped spill can actually act on.
 *
 * THE ERROR THIS LOCKS OUT, which was made and caught rather than imagined. The
 * simulation originally capped every tool result, including `read`. `read` is
 * exempt from artifact spill ON PURPOSE: it is bounded by LINES, not bytes, so a
 * byte spill would hand back fewer lines than the caller asked for and break the
 * one contract the tool has. Simulating a cap over its output predicts a saving the
 * shipped lever cannot deliver, and `read` carried the largest mean result in the
 * Claude baseline, so the overstatement was not small: a 5 KB threshold looked like
 * 24.9% of the bill and is really 13.5%. An arm was sized on the wrong number and
 * would have been run against a target it could not reach.
 */
describe("simulateToolResultCap — never predict a saving the shipped lever cannot make", () => {
	const call = (id: string, name: string) => ({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1 },
			content: [{ type: "toolCall", id, name, arguments: {} }],
		},
	});
	const resultFor = (id: string, chars: number) => ({
		type: "message",
		message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "r".repeat(chars) }] },
	});
	const turn = () => ({ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } });

	/** A spillable tool's excess above the cap is counted, which is the ordinary case. */
	test("counts the excess above the cap for a spillable tool", () => {
		const removed = simulateToolResultCap([call("a", "eval"), resultFor("a", 10_000), turn()], 2000);
		expect(removed.removed).toBe(8000 - SPILL_SUBSTITUTION_CHARS);
	});

	/**
	 * THE EXEMPTION, stated as arithmetic. The identical result produced by `read`
	 * contributes NOTHING to the predicted saving, because the shipped spill returns
	 * early for that tool and the bytes stay in the prefix whatever the threshold is.
	 */
	test("counts nothing for a tool the shipped spill exempts", () => {
		const removed = simulateToolResultCap([call("a", "read"), resultFor("a", 10_000), turn()], 2000);
		expect(removed.removed).toBe(0);
	});

	/**
	 * Both together, so the exemption is a filter rather than an all-or-nothing
	 * switch: the spillable result is charged and the exempt one is not, in the same
	 * session and against the same cap.
	 */
	test("separates spillable from exempt mass in one session", () => {
		// Both calls in ONE assistant message, so exactly one billed turn follows both
		// results and the expected figure is unambiguous. Issuing them as two separate
		// assistant messages would bill an extra turn in between and charge the first
		// result twice, which says nothing about the exemption under test.
		const bothCalls = {
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 1 },
				content: [
					{ type: "toolCall", id: "a", name: "eval", arguments: {} },
					{ type: "toolCall", id: "b", name: "read", arguments: {} },
				],
			},
		};
		const records = [bothCalls, resultFor("a", 10_000), resultFor("b", 10_000), turn()];
		// Only `eval`'s 8,000 excess, less the marker and footer that replace it.
		// `read`'s identical 10,000 contributes nothing.
		expect(simulateToolResultCap(records, 2000).removed).toBe(8000 - SPILL_SUBSTITUTION_CHARS);
	});

	/**
	 * The exempt set is a parameter, so a future change to which tools spill is
	 * expressed by passing a different set rather than by editing the arithmetic.
	 * Passing an empty set reproduces the old, wrong behaviour, which is the clearest
	 * possible statement of what the exemption is worth.
	 */
	test("treats the exempt set as a parameter, and an empty set restores the overstatement", () => {
		const records = [call("a", "read"), resultFor("a", 10_000), turn()];
		expect(simulateToolResultCap(records, 2000, []).removed).toBe(8000 - SPILL_SUBSTITUTION_CHARS);
		expect(simulateToolResultCap(records, 2000, ["read"]).removed).toBe(0);
	});

	/** A result under the cap contributes nothing, spillable or not. */
	test("counts nothing for a result already under the cap", () => {
		expect(simulateToolResultCap([call("a", "eval"), resultFor("a", 500), turn()], 2000).removed).toBe(0);
	});

	/**
	 * A result whose call cannot be identified is treated as SPILLABLE. The
	 * alternative, treating it as exempt, would silently shrink the predicted saving
	 * whenever the transcript shape changed, and a lever that quietly under-reports is
	 * harder to notice than one that over-reports against a known exempt list.
	 */
	test("treats a result with no identifiable tool as spillable", () => {
		const orphan = {
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "r".repeat(10_000) }] },
		};
		expect(simulateToolResultCap([orphan, turn()], 2000).removed).toBe(8000 - SPILL_SUBSTITUTION_CHARS);
	});
});

/**
 * The signature length cap, which is the primary cost lever, simulated rather than asserted.
 *
 * WHY THIS SUITE EXISTS. The 22.8% figure that justifies `arms/sig-max4000.yml` was
 * originally worked out by hand. Every other lever in this module is simulated by a
 * tested function; this one, the largest and the one about to be spent on quota, was
 * a number in a comment. That asymmetry is exactly how a wrong figure survives, and
 * it is how the tool-result cap came to be sized against a simulation of behaviour
 * the shipped code does not implement.
 *
 * The arithmetic that has to stay right: a capped signature is REPLACED by Gemini's
 * 33-character sentinel, not deleted, so the saving is its length minus 33 and never
 * its whole length.
 */
describe("simulateSignatureCap — the primary lever, reproducible from the transcript", () => {
	const sig = (chars: number) => ({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1 },
			content: [{ type: "toolCall", thoughtSignature: "s".repeat(chars), arguments: {} }],
		},
	});
	const turn = () => ({ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } });

	/**
	 * THE SENTINEL SUBSTITUTION, which is the whole difference between this and a
	 * naive count. A 5,000-character signature over the cap saves 5,000 minus 33, not
	 * 5,000. Counting the full length would overstate the lever by 33 characters per
	 * signature per turn, which compounds over a long session.
	 */
	test("credits the saving net of the 33-character sentinel", () => {
		const sim = simulateSignatureCap([sig(5000), turn()], 1000);
		expect(sim.removed).toBe(5000 - 33);
	});

	/** A signature at or under the cap is sent in full and saves nothing. */
	test("saves nothing on a signature within the cap", () => {
		expect(simulateSignatureCap([sig(500), turn()], 1000).removed).toBe(0);
		expect(simulateSignatureCap([sig(1000), turn()], 1000).removed).toBe(0);
	});

	/**
	 * The saving is charged once per turn the signature survives into, exactly as the
	 * prefix mass is, because that is what the provider re-reads. A single count would
	 * understate a lever whose whole value is avoiding repeated re-reads.
	 */
	test("charges the saving once per billed turn the signature survives into", () => {
		const oneTurn = simulateSignatureCap([sig(5000), turn()], 1000);
		const threeTurns = simulateSignatureCap([sig(5000), turn(), turn(), turn()], 1000);
		expect(threeTurns.removed).toBe(oneTurn.removed * 3);
	});

	/**
	 * A signature is never charged on the turn that produced it, matching the ordering
	 * rule the rest of this module uses: the turn was billed against the prefix that
	 * preceded it and could not have re-read its own output.
	 */
	test("does not credit a saving on the turn that produced the signature", () => {
		expect(simulateSignatureCap([sig(5000)], 1000).removed).toBe(0);
	});

	/**
	 * `touched` counts tool calls that lose their signature, which is how much
	 * reasoning replay the arm gives up. It is the number that makes a size cap
	 * comparable to a recency window: the cap reaches its saving by touching a small
	 * minority of calls, where a one-message window touches all of history.
	 */
	test("counts the tool calls that lose their signature, not the ones that keep it", () => {
		const sim = simulateSignatureCap([sig(5000), sig(100), sig(9000), turn()], 1000);
		expect(sim.signatures).toBe(3);
		expect(sim.touched).toBe(2);
	});

	/**
	 * A LOWER CAP SAVES MORE AND TOUCHES MORE, which is the trade the arm is choosing
	 * a point on. If this ordering ever inverted, the sweep the arm was selected from
	 * would be meaningless.
	 */
	test("saves more and touches more as the cap tightens", () => {
		const records = [sig(500), sig(3000), sig(9000), turn(), turn()];
		const loose = simulateSignatureCap(records, 8000);
		const tight = simulateSignatureCap(records, 1000);
		expect(tight.removed).toBeGreaterThan(loose.removed);
		expect(tight.touched).toBeGreaterThan(loose.touched);
	});

	/** A transcript with no signatures reports zeros rather than dividing by zero downstream. */
	test("reports zeros for a transcript with no signatures", () => {
		expect(simulateSignatureCap([turn(), turn()], 1000)).toEqual({
			removed: 0,
			total: 0,
			touched: 0,
			signatures: 0,
		});
	});

	/**
	 * The sweep the arm documentation quotes is the one the tool prints, so the arm's
	 * table cannot drift away from the instrument that produced it.
	 */
	test("sweeps the caps the shipped arm was chosen from", () => {
		expect(SIGNATURE_CAP_SWEEP).toEqual([8000, 4000, 2000, 1000]);
	});
});

describe("simulateSignatureLever — one simulator for both signature rules", () => {
	const sig = (chars: number) => ({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1 },
			content: [{ type: "toolCall", thoughtSignature: "s".repeat(chars), arguments: {} }],
		},
	});
	const turn = () => ({ type: "message", message: { role: "assistant", usage: { input: 1 }, content: [] } });
	const kept = 5000 - SKIP_SIGNATURE_CHARS;

	/**
	 * THE CAP SIMULATION IS THIS FUNCTION, not a second copy of the rule.
	 *
	 * Both the saving and the cache-stability verdict for a lever must come from one
	 * predicate, or an arm can be sized under one definition of "elided" and cached
	 * under another, and nothing would fail. `simulateSignatureCap` used to carry its
	 * own inline copy of `length > cap`; this pins that it is now a wrapper.
	 */
	test("the cap wrapper agrees with the lever it delegates to, signature for signature", () => {
		const records = [sig(500), sig(3000), sig(9000), turn(), turn()];
		expect(simulateSignatureCap(records, 2000)).toEqual(
			simulateSignatureLever(records, { kind: "sizeCap", maxLength: 2000 }),
		);
	});

	/**
	 * A RECENCY WINDOW ELIDES BY POSITION, NOT BY SIZE, and only once a signature has
	 * fallen out of the window. This is the property that separates it from a cap and
	 * the reason it rewrites history: the same signature is sent in full on one turn
	 * and replaced by the sentinel on the next.
	 *
	 * The arithmetic, spelled out because a wrong boundary here would silently change
	 * every retention figure. Four assistant messages: the two signatures are produced
	 * first, then two empty turns. On the second signature's turn one signature exists
	 * and is still inside a one-message window, so nothing is saved. On the third turn
	 * the first signature has aged out and is elided once. On the fourth both have,
	 * so both are elided. That is three elisions of (5000 - 33) characters.
	 */
	test("elides a signature only on the turns after it leaves the window", () => {
		const sim = simulateSignatureLever([sig(5000), sig(5000), turn(), turn()], {
			kind: "retainLast",
			assistantMessages: 1,
		});
		expect(sim.removed).toBe(3 * kept);
	});

	/**
	 * A DEEPER WINDOW SAVES LESS GROSS, which is the trade `sig-last8` is a point on.
	 * If this ordering inverted, the retention sweep would be meaningless.
	 */
	test("saves less as the window keeps more messages", () => {
		const records = [sig(5000), sig(5000), sig(5000), turn(), turn(), turn()];
		const shallow = simulateSignatureLever(records, { kind: "retainLast", assistantMessages: 1 });
		const deep = simulateSignatureLever(records, { kind: "retainLast", assistantMessages: 8 });
		expect(shallow.removed).toBeGreaterThan(deep.removed);
		expect(deep.removed).toBe(0);
	});

	/**
	 * A recency window is indifferent to signature size, where a cap is defined by it.
	 * Measuring one rule with the other's intuition is exactly the mistake that put a
	 * 5 KB tool-result threshold in an arm file at nearly twice its real saving.
	 */
	test("elides a small signature that a cap would keep", () => {
		const records = [sig(50), turn(), turn()];
		expect(simulateSignatureCap(records, 1000).removed).toBe(0);
		expect(simulateSignatureLever(records, { kind: "retainLast", assistantMessages: 1 }).removed).toBe(
			50 - SKIP_SIGNATURE_CHARS,
		);
	});

	/**
	 * `touched` counts signatures elided on at least ONE turn, so a cap and a window
	 * are comparable on the same axis: how much reasoning replay the arm gives up. On
	 * the measured Gemini baseline the cap touches 348 of 2,297 signatures and a
	 * one-message window touches 2,276, which is the whole argument for preferring the
	 * cap at a similar saving.
	 */
	test("counts a signature once however many turns it is elided on", () => {
		const sim = simulateSignatureLever([sig(5000), sig(5000), turn(), turn(), turn()], {
			kind: "retainLast",
			assistantMessages: 1,
		});
		expect(sim.signatures).toBe(2);
		expect(sim.touched).toBe(2);
	});

	/** The stock lever is the no-op control: it sends everything and saves nothing. */
	test("the stock lever removes nothing and touches nothing", () => {
		const sim = simulateSignatureLever([sig(5000), sig(100), turn(), turn()], { kind: "stock" });
		expect(sim.removed).toBe(0);
		expect(sim.touched).toBe(0);
		expect(sim.signatures).toBe(2);
	});

	/**
	 * `total` is the unlevered prefix walk, so it does not move when the lever does.
	 * The saving is a SHARE of that denominator, and a simulator that shrank its own
	 * denominator alongside its numerator would report a larger saving for every
	 * lever.
	 */
	test("reports the same denominator whatever the lever removes", () => {
		const records = [sig(5000), sig(5000), turn(), turn()];
		const stock = simulateSignatureLever(records, { kind: "stock" }).total;
		expect(simulateSignatureLever(records, { kind: "sizeCap", maxLength: 100 }).total).toBe(stock);
		expect(simulateSignatureLever(records, { kind: "retainLast", assistantMessages: 1 }).total).toBe(stock);
	});

	/**
	 * A recency window rewrites bytes it already sent, so its gross saving is not its
	 * net one; a cap's is. The two functions must therefore be read together, and this
	 * pins that they disagree in the direction the arm docs claim.
	 */
	test("the window invalidates cached bytes where the cap invalidates none", () => {
		const records = [sig(5000), sig(5000), turn(), turn()];
		expect(prefixStability(records, { kind: "sizeCap", maxLength: 100 }).invalidatedCharTurns).toBe(0);
		expect(
			prefixStability(records, { kind: "retainLast", assistantMessages: 1 }).invalidatedCharTurns,
		).toBeGreaterThan(0);
	});
});

describe("conversationCollapsed — an arm that died at startup is not a lever that removed everything", () => {
	/**
	 * A prefix mass with the given system and signature bytes and nothing else.
	 * Signature stands in for conversation generally; the guard does not care which
	 * non-system category the mass is in.
	 */
	const mass = (system: number, conversation: number) => ({
		...emptyPrefixMass(),
		system,
		signature: conversation,
	});

	/**
	 * THE OUTPUT THIS PREVENTS, seen on real data. In
	 * `runs/2026-07-25T20-46-08-607Z` every `sig-last1` trial died on a provider
	 * quota right after `session_init`, so its sessions are 96.6% system prompt and
	 * 0.0% of every other category. Rendered as a composition shift that reads as a
	 * lever which removed all the signatures, all the tool results and all the
	 * thinking at once: the most impressive table the report can print, describing an
	 * arm that never ran.
	 */
	test("refuses a comparison when the treatment sessions carry almost no conversation", () => {
		expect(conversationCollapsed(mass(1000, 9000), 10, mass(1000, 10), 10)).toBe(true);
	});

	/** Two healthy arms compare normally, including one that genuinely shed most of a category. */
	test("allows a comparison when the treatment really ran", () => {
		expect(conversationCollapsed(mass(1000, 9000), 10, mass(1000, 5000), 10)).toBe(false);
	});

	/**
	 * The test is PER SESSION, not on the total. An arm truncated to a third of the
	 * trials still did full work in the ones it ran, and refusing there would throw
	 * away the composition evidence from exactly the runs quota truncation produces.
	 */
	test("judges per session, so a truncated but healthy arm still compares", () => {
		expect(conversationCollapsed(mass(1000, 9000), 10, mass(300, 2700), 3)).toBe(false);
	});

	/**
	 * The threshold is a share of the BASELINE of the same run, because how much
	 * conversation a healthy session produces is a property of the task set rather
	 * than a constant. A fixed byte count would misjudge every workload but one.
	 */
	test("scales the threshold to the baseline of the same run", () => {
		const tiny = mass(1000, 100);
		expect(conversationCollapsed(tiny, 10, mass(1000, 50), 10)).toBe(false);
		expect(conversationCollapsed(mass(1000, 100_000), 10, mass(1000, 50), 10)).toBe(true);
	});

	/** With no baseline conversation to compare against there is no basis to refuse, so it does not. */
	test("does not refuse when the baseline itself carries no conversation", () => {
		expect(conversationCollapsed(mass(1000, 0), 10, mass(1000, 0), 10)).toBe(false);
	});

	/** The system prompt is excluded, since it is identical in every session and predates any work. */
	test("excludes the system prompt, which says nothing about whether work happened", () => {
		expect(conversationMassPerSession(mass(50_000, 1000), 10)).toBe(100);
	});

	/** A zero session count yields zero rather than a division by zero downstream. */
	test("reports zero conversation for zero sessions", () => {
		expect(conversationMassPerSession(mass(1000, 9000), 0)).toBe(0);
	});

	/** The threshold is pinned so a later loosening is a deliberate, visible change. */
	test("refuses below a tenth of the baseline conversation", () => {
		expect(COLLAPSED_CONVERSATION_SHARE).toBe(0.1);
	});
});
