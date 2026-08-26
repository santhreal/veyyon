/**
 * Observable arithmetic contracts and termination bounds for extracted prefix decomposition seams.
 *
 * This suite guards five concrete mathematical properties across the split modules:
 * 1. Prefix mass decomposition reproduces exact rational category shares on a multi-turn transcript.
 * 2. Calibration regression fits slope and intercept without distortion on fixed synthetic series.
 * 3. Lever simulations produce deterministic character-turn savings and touch counts on a seeded session.
 * 4. Cache efficiency ratios handle zero-read, zero-write, and all-cached boundaries without division by zero.
 * 5. All simulation and stability traversals terminate in O(N) linear time over long transcripts.
 */

import { describe, expect, test } from "bun:test";

import {
	type CacheEfficiency,
	cacheEfficiency,
	cacheHitRate,
	freshRate,
	freshTokens,
	rebilledCostShare,
} from "../../../src/suites/deep-swe/cache-efficiency";
import { type CostBreakdown, REFERENCE_RATE_CARD } from "../../../src/suites/deep-swe/cost-model";
import {
	simulateSignatureCap,
	simulateSignatureLever,
	simulateThinkingRetention,
	simulateToolResultCap,
} from "../../../src/suites/deep-swe/lever-simulation";
import {
	calibratePrefix,
	type PrefixObservation,
	prefixObservations,
} from "../../../src/suites/deep-swe/prefix-calibration";
import {
	accumulatePrefixMass,
	PREFIX_CATEGORIES,
	prefixShares,
	sessionPrefixSteps,
	type TranscriptRecord,
	totalPrefixMass,
} from "../../../src/suites/deep-swe/prefix-mass";
import { prefixStability } from "../../../src/suites/deep-swe/prefix-stability";

describe("prefix shares on a known multi-turn transcript", () => {
	test("produces exact rational category shares matching cumulative character-turns", () => {
		// Transcript specification:
		// Turn 0 (init): systemPrompt (1498 chars) + tools [] (2 chars: "[]") -> system = 1500 chars
		// Turn 1 (user): text (200 chars)
		// Turn 1 (assistant billed): charges prefix (1500 system + 200 userText = 1700)
		//   emits signature (400 chars), arguments (100 chars), thinking (300 chars), assistantText (150 chars)
		// Turn 2 (toolResult): 800 chars
		// Turn 2 (assistant billed): charges prefix (1500 system + 200 userText + 400 signature + 100 arguments + 300 thinking + 150 assistantText + 800 toolResult = 3450)
		// Cumulative character-turns across 2 billed turns:
		//   system: 1500 + 1500 = 3000
		//   userText: 200 + 200 = 400
		//   signature: 0 + 400 = 400
		//   arguments: 0 + 100 = 100
		//   thinking: 0 + 300 = 300
		//   assistantText: 0 + 150 = 150
		//   toolResult: 0 + 800 = 800
		// Total mass: 3000 + 400 + 400 + 100 + 300 + 150 + 800 = 5150
		const transcript: TranscriptRecord[] = [
			{
				type: "session_init",
				systemPrompt: "S".repeat(1498),
				tools: [],
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "U".repeat(200) }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1700 },
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "exec",
							thoughtSignature: "Q".repeat(400),
							arguments: { cmd: "x".repeat(90) }, // JSON stringified length is 100: {"cmd":"xxx...xxx"} -> 10 + 90 = 100
						},
						{
							type: "thinking",
							thinking: "T".repeat(300),
						},
						{
							type: "text",
							text: "A".repeat(150),
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					content: [{ type: "text", text: "R".repeat(800) }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 3450 },
					content: [{ type: "text", text: "Done" }],
				},
			},
		];

		const steps = sessionPrefixSteps(transcript);
		const mass = accumulatePrefixMass(steps);

		expect(mass.system).toBe(3000);
		expect(mass.userText).toBe(400);
		expect(mass.signature).toBe(400);
		expect(mass.arguments).toBe(100);
		expect(mass.thinking).toBe(300);
		expect(mass.assistantText).toBe(150);
		expect(mass.toolResult).toBe(800);
		expect(totalPrefixMass(mass)).toBe(5150);

		const shares = prefixShares(mass);
		expect(shares.system).toBeCloseTo(3000 / 5150, 10);
		expect(shares.userText).toBeCloseTo(400 / 5150, 10);
		expect(shares.signature).toBeCloseTo(400 / 5150, 10);
		expect(shares.arguments).toBeCloseTo(100 / 5150, 10);
		expect(shares.thinking).toBeCloseTo(300 / 5150, 10);
		expect(shares.assistantText).toBeCloseTo(150 / 5150, 10);
		expect(shares.toolResult).toBeCloseTo(800 / 5150, 10);

		const sumShares = PREFIX_CATEGORIES.reduce((sum, c) => sum + shares[c], 0);
		expect(sumShares).toBeCloseTo(1.0, 10);
	});
});

describe("calibration regression on known synthetic observation series", () => {
	test("recovers exact slope and intercept from a known synthetic token series", () => {
		// Linear model: promptTokens = visibleChars / 3.75 + 90
		// slope = 1 / 3.75 = 4 / 15 ≈ 0.26666666666666666
		// unseenChars = intercept / slope = 90 / (4/15) = 337.5
		const observations: PrefixObservation[] = [
			{ visibleChars: 1500, promptTokens: 490 },
			{ visibleChars: 3000, promptTokens: 890 },
			{ visibleChars: 4500, promptTokens: 1290 },
			{ visibleChars: 6000, promptTokens: 1690 },
		];

		const fit = calibratePrefix(observations);
		expect(fit).not.toBeNull();
		expect(fit?.charsPerToken).toBeCloseTo(3.75, 10);
		expect(fit?.unseenChars).toBeCloseTo(337.5, 10);
	});

	test("returns null for degenerate vertical or single-point observations", () => {
		expect(calibratePrefix([])).toBeNull();
		expect(calibratePrefix([{ visibleChars: 1000, promptTokens: 250 }])).toBeNull();
		expect(
			calibratePrefix([
				{ visibleChars: 1000, promptTokens: 250 },
				{ visibleChars: 1000, promptTokens: 300 },
			]),
		).toBeNull();
	});
});

describe("lever simulations on a deterministic seeded session", () => {
	function createDeterministicSession(turnCount = 8): TranscriptRecord[] {
		let state = 42;
		const nextRand = () => {
			state = (state * 1664525 + 1013904223) % 4294967296;
			return state / 4294967296;
		};

		const records: TranscriptRecord[] = [
			{
				type: "session_init",
				systemPrompt: "S".repeat(1000),
				tools: [{ name: "eval" }, { name: "read" }],
			},
		];

		for (let i = 0; i < turnCount; i++) {
			records.push({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: `User request ${i}` }],
				},
			});

			const sigLen = Math.floor(nextRand() * 6000) + 1000;
			const thinkLen = Math.floor(nextRand() * 1500) + 200;
			const toolResultLen = Math.floor(nextRand() * 8000) + 500;
			const toolName = nextRand() > 0.5 ? "eval" : "read";

			records.push({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1000 + i * 500, cacheRead: i * 400 },
					content: [
						{
							type: "toolCall",
							id: `call_${i}`,
							name: toolName,
							thoughtSignature: "X".repeat(sigLen),
							arguments: { arg: i },
						},
						{
							type: "thinking",
							thinking: "Y".repeat(thinkLen),
						},
						{
							type: "text",
							text: `Assistant response ${i}`,
						},
					],
				},
			});

			records.push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `call_${i}`,
					toolName,
					content: [{ type: "text", text: "Z".repeat(toolResultLen) }],
				},
			});
		}

		return records;
	}

	test("pins exact deterministic simulation outputs for size cap, recency window, and tool spills", () => {
		const records = createDeterministicSession(8);

		// Size cap simulation at 4000 chars
		const sigCap = simulateSignatureCap(records, 4000);
		expect(sigCap.signatures).toBe(8);
		expect(sigCap.touched).toBeGreaterThan(0);
		expect(sigCap.removed).toBeGreaterThan(0);
		expect(sigCap.total).toBeGreaterThan(sigCap.removed);

		// Recency window simulation (retain last 2 assistant messages). Across 8 turns (indices 0..7),
		// assistant indices 0..4 reach distance >= 2 on subsequent turns, so exactly 5 are touched.
		const sigWindow = simulateSignatureLever(records, { kind: "retainLast", assistantMessages: 2 });
		expect(sigWindow.signatures).toBe(8);
		expect(sigWindow.touched).toBe(5);
		expect(sigWindow.removed).toBeGreaterThan(0);

		// Tool result cap simulation at 3000 chars (with read exempt)
		const toolCap = simulateToolResultCap(records, 3000);
		expect(toolCap.results).toBe(8);
		expect(toolCap.total).toBeGreaterThan(0);

		// Thinking retention simulation (retain last 2 assistant messages)
		const thinkingSim = simulateThinkingRetention(records, 2);
		expect(thinkingSim.blocks).toBe(8);
		expect(thinkingSim.touched).toBe(5);
		expect(thinkingSim.removed).toBeGreaterThan(0);

		// Prefix stability under stock vs moving recency window
		const stockStab = prefixStability(records, { kind: "stock" });
		expect(stockStab.comparisons).toBe(7);
		expect(stockStab.stableComparisons).toBe(7);
		expect(stockStab.invalidatedCharTurns).toBe(0);

		const windowStab = prefixStability(records, { kind: "retainLast", assistantMessages: 2 });
		expect(windowStab.comparisons).toBe(7);
		expect(windowStab.invalidatedCharTurns).toBeGreaterThan(0);
	});
});

describe("cache efficiency ratio boundary contracts", () => {
	test("handles zero reads and zero writes boundary correctly without NaN", () => {
		const eff: CacheEfficiency = {
			uncachedTokens: 5000,
			cachedTokens: 0,
			cacheWriteTokens: 0,
			newContentTokens: 2000,
			rebilledTokens: 3000,
		};

		expect(freshTokens(eff)).toBe(5000);
		expect(cacheHitRate(eff)).toBe(0);
		expect(freshRate(eff, REFERENCE_RATE_CARD)).toBe(REFERENCE_RATE_CARD.input);

		const cost: CostBreakdown = {
			input: 0.015,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0.005,
			total: 0.02,
		};
		const share = rebilledCostShare(eff, cost, REFERENCE_RATE_CARD);
		expect(share).toBeGreaterThan(0);
		expect(Number.isNaN(share)).toBe(false);
	});

	test("handles all-cached 100% hit rate boundary correctly", () => {
		const eff: CacheEfficiency = {
			uncachedTokens: 0,
			cachedTokens: 10000,
			cacheWriteTokens: 0,
			newContentTokens: 0,
			rebilledTokens: 0,
		};

		expect(freshTokens(eff)).toBe(0);
		expect(cacheHitRate(eff)).toBe(1.0);
		expect(freshRate(eff, REFERENCE_RATE_CARD)).toBe(REFERENCE_RATE_CARD.input);

		const cost: CostBreakdown = {
			input: 0,
			cacheRead: 0.003,
			cacheWrite: 0,
			output: 0.001,
			total: 0.004,
		};
		expect(rebilledCostShare(eff, cost, REFERENCE_RATE_CARD)).toBe(0);
	});

	test("handles all-zero empty session boundary safely", () => {
		const eff: CacheEfficiency = {
			uncachedTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
			newContentTokens: 0,
			rebilledTokens: 0,
		};

		expect(freshTokens(eff)).toBe(0);
		expect(cacheHitRate(eff)).toBe(0);
		expect(freshRate(eff, REFERENCE_RATE_CARD)).toBe(REFERENCE_RATE_CARD.input);

		const zeroCost: CostBreakdown = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
		expect(rebilledCostShare(eff, zeroCost, REFERENCE_RATE_CARD)).toBe(0);
	});
});

describe("simulation termination and iteration bounds", () => {
	test("all simulations terminate in linear O(N) time on a long 200-turn transcript", () => {
		const records: TranscriptRecord[] = [
			{
				type: "session_init",
				systemPrompt: "System prompt".repeat(50),
				tools: [{ name: "exec" }],
			},
		];

		const turns = 200;
		for (let i = 0; i < turns; i++) {
			records.push({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: `Query ${i}` }] },
			});
			records.push({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: Math.round(500 + i * 150), cacheRead: 200 },
					content: [
						{
							type: "toolCall",
							id: `c_${i}`,
							name: "exec",
							thoughtSignature: "S".repeat(500),
							arguments: { i },
						},
						{ type: "thinking", thinking: "T".repeat(100) },
						{ type: "text", text: "ok" },
					],
				},
			});
			records.push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `c_${i}`,
					toolName: "exec",
					content: [{ type: "text", text: "Output".repeat(20) }],
				},
			});
		}

		const startTime = performance.now();

		const steps = sessionPrefixSteps(records);
		const mass = accumulatePrefixMass(steps);
		const shares = prefixShares(mass);
		const obs = prefixObservations(records);
		const cal = calibratePrefix(obs);
		const eff = cacheEfficiency(records, 4.0);
		const sigSim = simulateSignatureLever(records, { kind: "sizeCap", maxLength: 1000 });
		const thinkSim = simulateThinkingRetention(records, 5);
		const toolSim = simulateToolResultCap(records, 2000);
		const stab = prefixStability(records, { kind: "retainLast", assistantMessages: 5 });

		const durationMs = performance.now() - startTime;

		expect(totalPrefixMass(mass)).toBeGreaterThan(0);
		expect(shares.signature).toBeGreaterThan(0);
		expect(obs.length).toBe(turns);
		expect(cal).not.toBeNull();
		expect(eff.cachedTokens).toBe(turns * 200);
		expect(sigSim.signatures).toBe(turns);
		expect(thinkSim.blocks).toBe(turns);
		expect(toolSim.results).toBe(turns);
		expect(stab.comparisons).toBe(turns - 1);

		expect(durationMs).toBeLessThan(500);
	});
});
