import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { contextUsageFrame } from "../../../collab/protocol";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

/**
 * WHY. `session.getContextUsage()` anchors on the last assistant's real
 * prompt-token count, and returns nothing while there is no such anchor -- which
 * is exactly the moment after a compaction, before the next response. The status
 * line turned that into `usage?.tokens ?? 0`, so the gauge painted a full bar and
 * the words `100% left` in the one moment it knew least, while `/context`
 * answered "Context usage is unavailable" about the same session. Both surfaces,
 * one fact, two answers -- and the confident one was the wrong one.
 *
 * THE CLASS. A surface never states a number it does not have. `formatContextLeft`
 * has always been able to spell the unknown (`? left`) and the bar has always
 * handled a null ratio; nothing could reach either, because the flattening
 * happened upstream in the component and again in the collab host's state frame.
 * The cases below pin the unknown travelling all the way from the session to the
 * rendered bytes, and pin that zero still means zero -- a session that genuinely
 * used no tokens reads `100% left`, because that IS the number.
 *
 * WHAT THIS DOES NOT CATCH. It does not prove `/context`'s own wording, which
 * belongs to that command's suites; it proves only that the footline stops
 * disagreeing with it. It does not cover the guest side of a collab session
 * rendering the null it now receives (the guest path reads `contextUsage.percent`
 * with its own fallback, asserted here only as far as the host's frame), and it
 * says nothing about the bar's colour ramp, which is a theme question.
 */

interface UsageShape {
	tokens: number;
	contextWindow: number;
}

function sessionWith(usage: UsageShape | undefined) {
	return {
		messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "hi" }] }],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => usage,
		state: {
			messages: [],
			model: { contextWindow: 128000 },
		},
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
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		getRunningNonTaskJobCount: () => 0,
		// Compaction off: the gauge denominates against the raw model window, so the
		// percentages below are the arithmetic and nothing else.
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

/** The rendered footline, ANSI stripped: what a reader actually sees. */
function line(usage: UsageShape | undefined): string {
	const statusLine = new StatusLineComponent(sessionWith(usage));
	const rendered = statusLine.renderQuietLine(200);
	return rendered === null ? "" : stripAnsi(rendered);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("a gauge never states a number it does not have", () => {
	it("says the count is unknown when the session has no anchor", () => {
		expect(line(undefined)).toContain("? left");
	});

	it("never claims a full context while the count is unknown", () => {
		const rendered = line(undefined);
		expect(rendered).not.toContain("100% left");
		expect(rendered).not.toContain("0% left");
	});

	it("keeps the unknown out of the breakdown other surfaces read", () => {
		const statusLine = new StatusLineComponent(sessionWith(undefined));
		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: null, contextWindow: 128000 });
	});

	// Zero is a real answer and must stay one: an unused session has spent no tokens,
	// and reporting that as unknown would be the same defect pointed the other way.
	it("still reports a real zero as a full context", () => {
		expect(line({ tokens: 0, contextWindow: 128000 })).toContain("100% left");
	});

	for (const [tokens, expected] of [
		[0, "100% left"],
		[12800, "90% left"],
		[64000, "50% left"],
		[128000, "0% left"],
	] as const) {
		it(`reports ${tokens} of 128000 tokens as ${expected}`, () => {
			expect(line({ tokens, contextWindow: 128000 })).toContain(expected);
		});
	}

	it("reports the anchored count once it arrives, replacing the unknown", () => {
		const statusLine = new StatusLineComponent(sessionWith(undefined));
		expect(stripAnsi(statusLine.renderQuietLine(200) ?? "")).toContain("? left");

		// A new component for the anchored session rather than mutating the first: the
		// breakdown is memoized against message identity on purpose, and this case is
		// about what a reader sees after the next response, not about cache eviction.
		const anchored = new StatusLineComponent(sessionWith({ tokens: 64000, contextWindow: 128000 }));
		expect(stripAnsi(anchored.renderQuietLine(200) ?? "")).toContain("50% left");
	});
});

describe("the frame a host sends a guest", () => {
	// The host does not compute this twice: `contextUsageFrame` is the one owner, and
	// these cases are what make the host's flattening observable at all -- a CollabHost
	// needs a relay to construct, so the projection is pinned where it lives.
	it("passes the unknown through instead of flattening it to zero", () => {
		expect(contextUsageFrame({ usedTokens: null, contextWindow: 300_000 })).toEqual({
			tokens: null,
			contextWindow: 300_000,
			percent: null,
		});
	});

	it("carries a real count as a percentage of the window it was measured against", () => {
		expect(contextUsageFrame({ usedTokens: 90_000, contextWindow: 300_000 })).toEqual({
			tokens: 90_000,
			contextWindow: 300_000,
			percent: 30,
		});
	});

	it("keeps a real zero a real zero", () => {
		expect(contextUsageFrame({ usedTokens: 0, contextWindow: 300_000 })).toEqual({
			tokens: 0,
			contextWindow: 300_000,
			percent: 0,
		});
	});

	it("reports no percentage worth having when the window is unknown", () => {
		expect(contextUsageFrame({ usedTokens: 90_000, contextWindow: 0 })).toEqual({
			tokens: 90_000,
			contextWindow: 0,
			percent: 0,
		});
	});
});
