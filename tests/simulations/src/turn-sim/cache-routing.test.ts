/**
 * One conversation has one prompt-cache identity, and every request the session
 * makes for it sends that identity.
 *
 * WHY THIS FILE EXISTS. Providers route prefix caching on
 * `promptCacheKey ?? sessionId`. The live turn populates that prefix; the side
 * requests the session makes for the SAME conversation (a summarization, a
 * branch summary) then read it, but only if they send the same pair. Every one of
 * those side calls sets the pair by hand, with a comment explaining that omitting
 * it cold-misses the whole conversation, which is exactly the shape of bug that
 * costs money and shows no symptom: the answer is identical, only the bill and
 * the latency move. Nothing in a transcript would ever show it.
 *
 * So the rows assert the EFFECTIVE key (`promptCacheKey ?? sessionId`, the
 * expression the providers evaluate) rather than either field, because a change
 * that moves the value from one field to the other is not a regression and a row
 * pinned to one field would fail on it. What must hold: the effective key is the
 * same for every request of one conversation, whoever made it and whatever
 * happened to the history in between.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed.
 *   - Nothing here proves a provider actually reads the key: the transport is
 *     replaced by the script. This is about what the session SENDS.
 *   - A fork or a `/tan` dispatch inherits a pinned key from its parent, which is
 *     a different mechanism (`providerPromptCacheKeySource: "fork"`) and needs a
 *     second session; the simulation runs one.
 *   - Advisor requests are not covered. They are built from the same expression
 *     but on a distinct provider session id, and no advisor runs here.
 *
 * RED PROOFS, observed rather than predicted.
 *   - the local summarization request sending `cold-${sessionId}` instead of the
 *     live key: only the summarizer row reds, which is what says that row is
 *     about the side request and not about turn-to-turn stability.
 *   - the agent stamping a fresh routing id on every request: all three rows red,
 *     so none of them is passing because the value happens to be constant for
 *     some unrelated reason.
 */
import { afterEach, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool, simulatedModel } from "./harness";

interface CacheRouted {
	readonly tools: number;
	readonly sessionId: string | undefined;
	readonly promptCacheKey: string | undefined;
}

/** What a provider evaluates to decide which cache prefix a request reads. */
function effectiveKey(call: CacheRouted): string | undefined {
	return call.promptCacheKey ?? call.sessionId;
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Settings that make the second prompt overflow a 16k window and compact. */
const COMPACTING = {
	"compaction.enabled": true,
	"compaction.thresholdTokens": 12_000,
	"compaction.keepRecentTokens": 2_000,
	// Local summarization: the remote path hands the whole job to the provider and
	// makes no summarizer request of its own to inspect.
	"compaction.remote": false,
} as const;

it("sends one effective key for every live turn and for the summarizer", async () => {
	const calls: CacheRouted[] = [];
	sim = await createSimulation({
		model: { contextWindow: 16_000 },
		settings: { ...COMPACTING },
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }))],
		script: turn => {
			calls.push({
				tools: turn.context.tools?.length ?? 0,
				sessionId: turn.cacheRouting.sessionId,
				promptCacheKey: turn.cacheRouting.promptCacheKey,
			});
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("first");
	// Big enough to trip the threshold on the next turn, which is what produces a
	// summarizer request to compare against the live ones.
	await sim.session.prompt(`bulk. ${"user bulk. ".repeat(6000)}`);

	const summarizer = calls.filter(call => call.tools === 0);
	const live = calls.filter(call => call.tools > 0);
	expect(summarizer.length).toBe(1);
	expect(live.length).toBeGreaterThanOrEqual(2);

	// The whole point: one value, every request.
	const keys = new Set(calls.map(effectiveKey));
	expect(keys.size).toBe(1);
	expect(effectiveKey(summarizer[0]!)).toBe(sim.session.sessionId);

	// Codex-family providers reject a routing id that is not UUID-shaped, so the
	// identity is not free-form: it is the session's UUIDv7.
	expect(effectiveKey(live[0]!)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

it("keeps the effective key across a model switch", async () => {
	const calls: CacheRouted[] = [];
	sim = await createSimulation({
		script: turn => {
			calls.push({
				tools: turn.context.tools?.length ?? 0,
				sessionId: turn.cacheRouting.sessionId,
				promptCacheKey: turn.cacheRouting.promptCacheKey,
			});
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("first");
	await sim.session.setModel(simulatedModel("sim-model-b"));
	await sim.session.prompt("after the switch");

	// Cache identity belongs to the conversation, not to the model: the provider
	// prefix is keyed per provider anyway, and re-keying here would throw away the
	// cache of every future turn on a switch back.
	expect(new Set(calls.map(effectiveKey)).size).toBe(1);
	expect(calls.length).toBe(2);
});

it("keeps the effective key across a history rewrite", async () => {
	const calls: CacheRouted[] = [];
	sim = await createSimulation({
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }))],
		script: turn => {
			calls.push({
				tools: turn.context.tools?.length ?? 0,
				sessionId: turn.cacheRouting.sessionId,
				promptCacheKey: turn.cacheRouting.promptCacheKey,
			});
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish();
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("go");
	const assistantEntry = sim.sessionManager
		.getEntries()
		.find(entry => entry.type === "message" && (entry.message as { role?: string }).role === "assistant");
	expect(assistantEntry).toBeDefined();

	// Navigating stays in the same session file, so the conversation is the same
	// conversation and its cache identity survives even though the rebuilt path
	// differs from what was sent before.
	await sim.session.navigateTree(assistantEntry!.id);
	await sim.session.prompt("continue");

	expect(new Set(calls.map(effectiveKey)).size).toBe(1);
	expect(calls.length).toBeGreaterThanOrEqual(3);
});
