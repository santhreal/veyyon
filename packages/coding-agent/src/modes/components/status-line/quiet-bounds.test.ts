/**
 * Quiet-footline hit-test bounds (GMI-2b).
 *
 * Why this suite exists: the footline is the click surface for status-line
 * mouse routing — a click is resolved to a segment purely from the bounds the
 * line records as it renders. If the recorded layout drifts from the actual
 * assembly (a separator width change, right-group alignment, a dropped part
 * under narrow widths), clicks silently hit the wrong segment or nothing.
 * These tests lock the invariants: every recorded slot maps back to its own
 * id, slots never overlap, right-group slots sit where the right group is
 * actually painted, and the inter-group gap reports null.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@veyyon/tui";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

function makeSession() {
	return {
		messages: [],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: { messages: [], model: { contextWindow: 128000 } },
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
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

const WIDTH = 120;

describe("quiet footline segment bounds", () => {
	it("records a slot for every rendered segment and each slot hit-tests back to its own id", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const line = statusLine.renderQuietLine(WIDTH);
		expect(line).not.toBeNull();
		const bounds = statusLine.getQuietSegmentBounds();
		expect(bounds.length).toBeGreaterThan(0);
		for (const slot of bounds) {
			expect(slot.end).toBeGreaterThan(slot.start);
			// First and last column of the slot both resolve to the same segment.
			expect(statusLine.quietSegmentAt(slot.start)).toBe(slot.id);
			expect(statusLine.quietSegmentAt(slot.end - 1)).toBe(slot.id);
		}
	});

	it("slots never overlap and stay inside the one-cell right margin", () => {
		const statusLine = new StatusLineComponent(makeSession());
		statusLine.renderQuietLine(WIDTH);
		const bounds = [...statusLine.getQuietSegmentBounds()].sort((a, b) => a.start - b.start);
		for (let i = 1; i < bounds.length; i++) {
			expect(bounds[i]!.start).toBeGreaterThanOrEqual(bounds[i - 1]!.end);
		}
		for (const slot of bounds) {
			expect(slot.end).toBeLessThanOrEqual(WIDTH - 1);
		}
	});

	it("right-group slots sit exactly where the painted line puts the right group", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const line = statusLine.renderQuietLine(WIDTH);
		expect(line).not.toBeNull();
		// The line's total visible width is budget (width-1) when both groups
		// render: the LAST slot must end exactly at the visible end of the line.
		const bounds = [...statusLine.getQuietSegmentBounds()].sort((a, b) => a.start - b.start);
		const last = bounds[bounds.length - 1]!;
		expect(last.end).toBe(visibleWidth(line!));
	});

	it("the model segment is addressable and the inter-group gap is not", () => {
		const statusLine = new StatusLineComponent(makeSession());
		statusLine.renderQuietLine(WIDTH);
		const bounds = statusLine.getQuietSegmentBounds();
		const model = bounds.find(slot => slot.id === "model");
		expect(model).toBeDefined();
		expect(statusLine.quietSegmentAt(Math.floor((model!.start + model!.end) / 2))).toBe("model");
		// The elastic padding between location and capability groups is dead
		// space: a click there must resolve to nothing, not a neighbor.
		const sorted = [...bounds].sort((a, b) => a.start - b.start);
		let gapCol = -1;
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i]!.start - sorted[i - 1]!.end >= 3) {
				gapCol = sorted[i - 1]!.end + 1;
				break;
			}
		}
		expect(gapCol).toBeGreaterThanOrEqual(0);
		expect(statusLine.quietSegmentAt(gapCol)).toBeNull();
	});

	it("bounds are rewritten per render: a line that vanishes leaves no stale targets", () => {
		const statusLine = new StatusLineComponent(makeSession());
		statusLine.renderQuietLine(WIDTH);
		expect(statusLine.getQuietSegmentBounds().length).toBeGreaterThan(0);
		// Width 1 → budget 1: nothing fits, the line degrades to (at most) a
		// truncated left group; every recorded slot must still hit-test within
		// the tiny budget or be gone entirely.
		statusLine.renderQuietLine(2);
		for (const slot of statusLine.getQuietSegmentBounds()) {
			expect(slot.start).toBeLessThan(1);
			expect(slot.end).toBeLessThanOrEqual(1);
		}
	});
});
