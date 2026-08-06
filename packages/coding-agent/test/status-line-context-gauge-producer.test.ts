/**
 * The context gauge at the seam that PRODUCES its numbers, with auto-compaction on.
 *
 * WHY THIS SUITE EXISTS. The gauge's headline bug was a single assignment in
 * `StatusLineComponent`: `contextWindow` was overwritten with the auto-compaction fire point
 * before the segment context was built, so every consumer that believed it held the model window
 * held the trigger instead. `context_total`, a segment whose entire job is to print the window,
 * printed `170k` for a 200k model.
 *
 * The fix split the two into `contextWindow` (the model's) and `contextLimit` (whichever comes
 * first: the fire point, or the window when auto-compaction is off). Every existing gauge test
 * hands those two fields to a segment ALREADY SEPARATED, in a synthesized `SegmentContext` — so
 * the segments are pinned and the code that fills the fields is not. Re-introducing the original
 * bug (`contextWindow = contextLimit` in the component) would leave the whole gauge suite green.
 *
 * These tests drive the real `StatusLineComponent.renderQuietLine` with compaction ENABLED and
 * read the rendered text, which is the only place the split is observable end to end. The gauge
 * prints room LEFT as a percentage, so the fire point shows up as the denominator it divides by
 * rather than as a printed number; `context_total` is what pins the window itself. The neighbouring
 * `status-line-context-cache.test.ts` covers the same component with compaction DISABLED, where
 * the limit and the window are the same number and the bug is invisible.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ContextUsage } from "@veyyon/coding-agent/extensibility/extensions/types";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line";
import type { StatusLineSegmentId } from "@veyyon/coding-agent/modes/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

const WINDOW = 200_000;

interface CompactionGroup {
	enabled: boolean;
	strategy: string;
	threshold: string;
}

interface SessionOptions {
	usedTokens: number;
	contextWindow?: number;
	compaction?: Partial<CompactionGroup>;
	/** A collab guest's host-supplied usage frame, which has a window and no trigger. */
	collabUsage?: ContextUsage;
}

function makeSession(options: SessionOptions): AgentSession {
	const contextWindow = options.contextWindow ?? WINDOW;
	const compaction: CompactionGroup = {
		enabled: true,
		strategy: "summarize",
		threshold: "85%",
		...options.compaction,
	};
	return {
		messages: [{ role: "user", content: "hi" }],
		systemPrompt: ["You are a helpful assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "test-model", contextWindow },
		state: { messages: [{ role: "user", content: "hi" }], model: { contextWindow } },
		sessionManager: {
			getUsageStatistics: () => ({
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
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { getGroup: () => compaction },
		getContextUsage: (): ContextUsage => ({
			tokens: options.usedTokens,
			contextWindow,
			percent: (options.usedTokens / contextWindow) * 100,
		}),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** The status line's top border with `segments` shown, ANSI stripped. */
function render(
	session: AgentSession,
	segments: StatusLineSegmentId[],
	options?: { guestUsage?: ContextUsage },
): string {
	const component = new StatusLineComponent(session);
	component.setAutoCompactEnabled(true);
	if (options?.guestUsage) {
		component.setCollabStatus({
			role: "guest",
			participantCount: 2,
			stateOverride: { contextUsage: options.guestUsage } as never,
		});
	}
	component.updateSettings({
		preset: "custom",
		leftSegments: segments,
		rightSegments: [],
	});
	return (component.renderQuietLine(120) ?? "").replaceAll(/\x1b\[[0-9;]*m/g, "");
}

describe("the gauge's numbers with auto-compaction on", () => {
	it("prints the model window in context_total, not the compaction fire point", () => {
		// THE bug, at the seam it lived at. `170K` here means the component overwrote
		// the window with the trigger again.
		const plain = render(makeSession({ usedTokens: 50_000 }), ["context_total"]);

		expect(plain).toContain("200K");
		expect(plain).not.toContain("170K");
	});

	it("measures used tokens against the fire point, because that is when the context runs out", () => {
		// The other half of the split, and the reason the fire point is computed at all:
		// with auto-compaction on, the room the operator has is room until the trigger.
		const plain = render(makeSession({ usedTokens: 85_000 }), ["context_pct"]);

		// 85k of a 170k fire point is exactly half the room. Measured against the
		// 200k window it would read 58% and overstate the room by eight points.
		expect(plain).toContain("50% left");
		expect(plain).not.toContain("58% left");
	});

	it("shows the window and the limit side by side, each in its own segment", () => {
		// The composition is the real contract: both numbers on screen at once, both
		// correct, and different. A single field cannot satisfy this test, which is
		// exactly why the original bug is unrepresentable now.
		const plain = render(makeSession({ usedTokens: 85_000 }), ["context_pct", "context_total"]);

		expect(plain).toContain("50% left");
		expect(plain).toContain("200K");
	});

	it("falls back to the window as the limit when the compaction strategy is off", () => {
		// `strategy: "off"` means nothing will fire, so the context runs out at the
		// window and the gauge must denominate against it. A stale fire point here
		// would tell the operator they are out of room while a third of the window is
		// still usable.
		const plain = render(makeSession({ usedTokens: 85_000, compaction: { strategy: "off" } }), [
			"context_pct",
			"context_total",
		]);

		expect(plain).toContain("58% left");
	});

	it("falls back to the window as the limit when compaction is disabled outright", () => {
		const plain = render(makeSession({ usedTokens: 85_000, compaction: { enabled: false } }), ["context_pct"]);

		expect(plain).toContain("58% left");
	});

	it("honours an absolute token threshold as the limit", () => {
		// The threshold is Tier A config and can be an absolute amount rather than a
		// percentage. The gauge reads whatever the resolver returns rather than
		// re-deriving a percentage of its own.
		const plain = render(makeSession({ usedTokens: 40_000, compaction: { threshold: "120000" } }), [
			"context_pct",
			"context_total",
		]);

		expect(plain).toContain("67% left");
		expect(plain).toContain("200K");
	});

	it("keeps the two apart on a large window, where the gap is largest", () => {
		// A 1M-window model puts 150k between the window and the trigger. This is the
		// size at which the old hidden absolute-token colour ladder also broke, so the
		// case is worth pinning at the producer as well.
		const plain = render(makeSession({ usedTokens: 100_000, contextWindow: 1_000_000 }), [
			"context_pct",
			"context_total",
		]);

		expect(plain).toContain("88% left");
		expect(plain).toContain("1M");
	});
});

describe("a collab guest's gauge", () => {
	it("denominates against the window the host told it about, never a local trigger", () => {
		// A guest computes no context of its own: the host's state frame carries a window
		// and a percent, and no compaction trigger. Resolving one from the GUEST's own
		// settings would denominate the host's usage against a fire point the host is not
		// subject to, so the guest's limit is the window it was handed.
		const plain = render(makeSession({ usedTokens: 0 }), ["context_pct", "context_total"], {
			guestUsage: { tokens: 90_000, contextWindow: 300_000, percent: 30 },
		});

		// 90k of the host's 300k window is 70% left. A locally resolved 85% trigger
		// on that window would be 255k, denominating to 65% left instead.
		expect(plain).toContain("70% left");
		expect(plain).not.toContain("65% left");
	});

	it("reports the host's own percentage rather than recomputing one", () => {
		// The host frame's percent is authoritative: the host knows its own limit, and a
		// guest recomputing `tokens / window` would disagree with the host's screen the
		// moment the host has auto-compaction on.
		const plain = render(makeSession({ usedTokens: 0 }), ["context_pct"], {
			guestUsage: { tokens: 90_000, contextWindow: 300_000, percent: 70 },
		});

		expect(plain).toContain("30% left");
	});
});

describe("the gauge reports room left, not room used", () => {
	it("draws a nearly full bar at the start of a session and says the room is left", () => {
		// A fuel gauge reads full when the tank is full. The bar used to fill as room
		// ran out, so an empty session showed an empty bar.
		const plain = render(makeSession({ usedTokens: 0 }), ["context_pct"]);

		expect(plain).toContain("100% left");
		expect(plain).toContain("▰");
		expect(plain).not.toContain("▱");
	});

	it("drains toward empty as the context fills, against the fire point", () => {
		// 85k of a 170k fire point is half the room, which is the number the operator
		// decides on. Measuring against the 200k window would print `58% left` and
		// overstate the room by 15 points.
		const plain = render(makeSession({ usedTokens: 85_000 }), ["context_pct"]);

		expect(plain).toContain("50% left");
		expect(plain).toContain("▰");
		expect(plain).toContain("▱");
	});

	it("says 0% left rather than a negative number once the fire point is passed", () => {
		// Used tokens can exceed the trigger between the crossing and the compaction
		// actually running, and `-10% left` is not a thing.
		const plain = render(makeSession({ usedTokens: 187_000 }), ["context_pct"]);

		expect(plain).toContain("0% left");
		expect(plain).not.toContain("-");
	});

	it("prints whole percentages, with no jittering decimal", () => {
		// 85,001/170,000 is 49.9994% used. The gauge used to print a tenth of a
		// percent that changed every turn on the surface users called confusing, and
		// no decision is made at that resolution.
		const plain = render(makeSession({ usedTokens: 85_001 }), ["context_pct"]);

		expect(plain).toContain("50% left");
		expect(plain).not.toMatch(/\d\.\d/);
	});
});
