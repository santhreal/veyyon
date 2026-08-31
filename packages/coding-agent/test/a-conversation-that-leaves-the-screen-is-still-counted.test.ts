/**
 * WHY: `/new` on a streaming turn hands the old conversation to
 * `BackgroundSessions` and attaches the screen to a fresh one. The old turn
 * keeps running, keeps calling the provider and keeps costing money, and
 * nothing draws it. Before the handoff existed the rule was simple and true:
 * something was streaming if it was on your screen. The handoff removed that
 * rule and put nothing in its place.
 *
 * The class this closes is "a running conversation with no surface". Not the
 * one incident — a card the operator has to know to open does not close it,
 * because the question it answers ("is anything spending right now") is one
 * you only think to ask once you already suspect the answer. The count has to
 * be continuous and it has to be somewhere already on screen, so this pins
 * three things:
 *
 * 1. The keeper reports arrivals AND departures, so the number can be pushed
 *    rather than polled.
 * 2. The chip is silent at zero and states the count otherwise.
 * 3. EVERY preset carries the chip, swept from the preset table at run time.
 *    A preset added later that omits it turns this red, because a cost signal
 *    an operator can lose by picking `minimal` is not a cost signal.
 *
 * WHAT IT DOES NOT CATCH. That the count is *correct* against real handoffs:
 * the keeper is driven directly here, and the wiring from keeper to status
 * line lives in the interactive-mode constructor, which needs a real TUI.
 * Nothing here reads pixels either, so a chip rendered into a zone the
 * footline then sheds at a narrow width would pass.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/terminal/components/status-line/presets";
import type { SegmentContext } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import { renderSegment } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { NO_SESSION_FACTS } from "../src/modes/terminal/components/status-line/session-facts";

beforeAll(async () => {
	await initTheme();
});

function contextWith(backgroundSessionCount: number): SegmentContext {
	return {
		facts: NO_SESSION_FACTS,
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		contextLimit: 0,
		contextLimitKind: "window" as const,
		autoCompactEnabled: false,
		subagentCount: 0,
		backgroundSessionCount,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		account: null,
		usage: null,
	};
}

function chip(count: number): { visible: boolean; text: string } {
	const rendered = renderSegment("background", contextWith(count));
	return { visible: rendered.visible, text: stripVTControlCharacters(rendered.content) };
}

/** A session that never finishes its turn, so the keeper holds it for the test. */
function pendingSession(id: string): { session: AgentSession; finish: () => void } {
	const turn = Promise.withResolvers<void>();
	const session = {
		waitForIdle: () => turn.promise,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/repo/.veyyon/${id}.jsonl`,
			flush: async () => {},
		},
	} as unknown as AgentSession;
	return { session, finish: turn.resolve };
}

describe("the keeper reports what it is holding", () => {
	it("fires when a conversation arrives, with the new count already readable", () => {
		const keeper = new BackgroundSessions();
		const seen: number[] = [];
		keeper.subscribe(() => seen.push(keeper.size));

		const first = pendingSession("a");
		keeper.keep(first.session);
		const second = pendingSession("b");
		keeper.keep(second.session);

		expect(seen).toEqual([1, 2]);
		first.finish();
		second.finish();
	});

	it("fires when a conversation settles, so the chip can go back to silent", async () => {
		const keeper = new BackgroundSessions();
		const seen: number[] = [];
		const only = pendingSession("a");
		const kept = keeper.keep(only.session);
		keeper.subscribe(() => seen.push(keeper.size));

		only.finish();
		await kept.settled;

		expect(seen).toEqual([0]);
		expect(keeper.size).toBe(0);
	});

	/**
	 * Handing the same object over twice is already idempotent for the entry.
	 * It must be idempotent for the notification too, or a chip driven by the
	 * event count drifts above the number of conversations that exist.
	 */
	it("does not fire again for a conversation it already holds", () => {
		const keeper = new BackgroundSessions();
		const only = pendingSession("a");
		keeper.keep(only.session);
		const seen: number[] = [];
		keeper.subscribe(() => seen.push(keeper.size));

		keeper.keep(only.session);

		expect(seen).toEqual([]);
		only.finish();
	});

	/**
	 * `attachMainSession` returns an entry whether or not anything moved, and
	 * re-attaching the session already on screen moves nothing. Describing it must
	 * not register it: `size` is the number the chip states, and the chip's whole
	 * claim is that it counts conversations nobody is looking at. Registering the
	 * displayed one makes the chip report spend to the person watching it happen.
	 */
	it("describes the displayed conversation without counting it as backgrounded", () => {
		const keeper = new BackgroundSessions();
		const seen: number[] = [];
		keeper.subscribe(() => seen.push(keeper.size));
		const onScreen = pendingSession("a");

		const entry = keeper.describeAttached(onScreen.session);

		expect(entry.sessionId).toBe("a");
		expect(entry.sessionFile).toBe("/repo/.veyyon/a.jsonl");
		expect(keeper.size).toBe(0);
		expect(seen).toEqual([]);
		onScreen.finish();
	});

	/**
	 * The other branch: a conversation it really is holding describes as the entry
	 * it is holding, so a caller that settles what it was handed settles the real
	 * one rather than a copy whose `settled` resolves immediately.
	 */
	it("describes a conversation it does hold with the entry it is holding", () => {
		const keeper = new BackgroundSessions();
		const only = pendingSession("a");
		const kept = keeper.keep(only.session);

		expect(keeper.describeAttached(only.session)).toBe(kept);
		expect(keeper.size).toBe(1);
		only.finish();
	});

	it("stops calling a listener that unsubscribed", () => {
		const keeper = new BackgroundSessions();
		let calls = 0;
		const off = keeper.subscribe(() => {
			calls++;
		});
		off();

		const only = pendingSession("a");
		keeper.keep(only.session);

		expect(calls).toBe(0);
		only.finish();
	});

	/**
	 * One listener that throws must not stop the next one from being told. A
	 * status line that silently stops updating because some other subscriber
	 * failed is the same invisible-cost defect wearing a different hat.
	 */
	it("keeps notifying after a listener throws", () => {
		const keeper = new BackgroundSessions();
		const seen: number[] = [];
		keeper.subscribe(() => {
			throw new Error("listener exploded");
		});
		keeper.subscribe(() => seen.push(keeper.size));

		const only = pendingSession("a");
		keeper.keep(only.session);

		expect(seen).toEqual([1]);
		only.finish();
	});
});

describe("the background chip", () => {
	it("says nothing when every conversation is on a screen", () => {
		expect(chip(0).visible).toBe(false);
		expect(chip(0).text).toBe("");
	});

	it("states the count once a conversation is running unwatched", () => {
		for (const count of [1, 2, 7, 40]) {
			const rendered = chip(count);
			expect(rendered.visible).toBe(true);
			expect(rendered.text).toContain(`${count}`);
		}
	});

	/**
	 * The number is what the operator reads, so it must be the count and not an
	 * adjacent quantity. `1 bg` and `2 bg` differ in exactly the digit.
	 */
	it("moves with the count rather than reporting a fixed badge", () => {
		expect(chip(1).text).not.toBe(chip(2).text);
	});
});

describe("every status line preset carries the chip", () => {
	/**
	 * Swept from the preset table rather than listed here, so adding a preset
	 * that omits the chip fails until someone records that decision. Opt-outs
	 * are pinned by exact equality, not by count: today there are none.
	 */
	it("has no preset that can hide a running background conversation", () => {
		const missing = Object.entries(STATUS_LINE_PRESETS)
			.filter(([, preset]) => ![...preset.leftSegments, ...preset.rightSegments].includes("background"))
			.map(([name]) => name);

		expect(missing).toEqual([]);
	});

	it("sweeps a preset table that is not empty, so the check above cannot pass vacuously", () => {
		expect(Object.keys(STATUS_LINE_PRESETS).length).toBeGreaterThan(3);
	});
});
