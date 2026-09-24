/**
 * The room chip names who needs you.
 *
 * WHY THIS SUITE EXISTS. A conversation off screen that stops on a question
 * for the operator has no surface of its own: its dialog waits until the
 * operator comes to it. The `room` status segment is the one place that says
 * so. The defect class is the chip reading wrong for the room it describes:
 * shown for an empty room, silent for a room with peers, a question hidden
 * behind "working" or placed after it (the rarer, more urgent state losing to
 * the common one), work dropped while a question is shown (a room that reads
 * idle apart from the question when two others are running), the question
 * painted in the quiet accent instead of the ember a waiting prompt takes, a
 * wrong count or a wrong plural, or a preset that drops the chip so an
 * operator who picked it never learns a peer is waiting.
 *
 * Every combination of peers, working and waiting in a small grid is rendered
 * through `renderSegment("room")` and compared, ANSI stripped, with the rule;
 * the colour is asserted on the painted bytes under a truecolor theme, and the
 * preset table is swept at run time with opt-outs pinned by exact equality.
 *
 * NOT CAUGHT. That the counts the chip receives are right: the room
 * controller suite owns `setRoomPeers`. Width shedding of the footline at a
 * narrow terminal is not exercised here.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/terminal/components/status-line/presets";
import {
	renderSegment,
	type SegmentContext,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import { NO_SESSION_FACTS } from "@veyyon/coding-agent/modes/terminal/components/status-line/session-facts";
import type { RoomPeerSummary } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { withIcon } from "@veyyon/coding-agent/theme/icon-label";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { useFullColor, useTruecolorTheme } from "../../../../helpers/theme-assertions";

function contextWith(roomPeers: RoomPeerSummary): SegmentContext {
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
		agentCount: 0,
		backgroundSessionCount: 0,
		roomPeers,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		account: null,
		usage: null,
	};
}

function chip(roomPeers: RoomPeerSummary): { visible: boolean; painted: string; text: string } {
	const rendered = renderSegment("room", contextWith(roomPeers));
	return { visible: rendered.visible, painted: rendered.content, text: stripVTControlCharacters(rendered.content) };
}

describe("the room chip", () => {
	// A theme whose `borderAccent` and `accent` are different colours; in the
	// default theme they are one, and a colour assertion there proves nothing.
	useTruecolorTheme("dark-dracula");

	it("is hidden when no conversation is beside this one, whatever the other counts say", () => {
		for (const summary of [
			{ peers: 0, working: 0, waiting: 0 },
			{ peers: 0, working: 2, waiting: 0 },
			{ peers: 0, working: 0, waiting: 1 },
		]) {
			expect(chip(summary)).toEqual({ visible: false, painted: "", text: "" });
		}
	});

	it("names the peers alone when none is working or waiting, singular for one", () => {
		expect(chip({ peers: 1, working: 0, waiting: 0 }).text).toBe(withIcon(theme.icon.agents, "1 peer"));
		expect(chip({ peers: 3, working: 0, waiting: 0 }).text).toBe(withIcon(theme.icon.agents, "3 peers"));
	});

	it("adds how many are working", () => {
		expect(chip({ peers: 2, working: 1, waiting: 0 }).text).toBe(
			`${withIcon(theme.icon.agents, "2 peers")}${theme.sep.dot}1 working`,
		);
	});

	/**
	 * A question is rarer and more urgent than work: with both, the chip names
	 * the question first and the work after it, as the room view's title does.
	 */
	it("names who needs you ahead of who is working, and keeps the work", () => {
		const text = chip({ peers: 3, working: 2, waiting: 1 }).text;
		expect(text).toBe(
			`${withIcon(theme.icon.agents, "3 peers")}${theme.sep.dot}${theme.status.warning} 1 needs you${theme.sep.dot}2 working`,
		);
	});

	/**
	 * The whole grid against the rule, so no combination the three counts can
	 * take reads differently from its neighbours by accident.
	 */
	it("reads every combination of peers, working and waiting by one rule", () => {
		for (const peers of [0, 1, 2, 5]) {
			for (const working of [0, 1, 3]) {
				for (const waiting of [0, 1, 2]) {
					const parts = [
						withIcon(theme.icon.agents, `${peers} ${peers === 1 ? "peer" : "peers"}`),
						...(waiting > 0 ? [`${theme.status.warning} ${waiting} needs you`] : []),
						...(working > 0 ? [`${working} working`] : []),
					];
					const expected = peers === 0 ? "" : parts.join(theme.sep.dot);
					expect({ peers, working, waiting, text: chip({ peers, working, waiting }).text }).toEqual({
						peers,
						working,
						waiting,
						text: expected,
					});
				}
			}
		}
	});

	/**
	 * The ember a waiting prompt takes is `borderAccent`; `accent` is the
	 * colour of work. The two escapes differ under this theme, so a chip that
	 * paints the question in accent fails here rather than passing on bytes
	 * that happen to agree. The policy is pinned to full colour, so neither the
	 * presence nor the absence of a colour holds vacuously under `NO_COLOR`.
	 */
	describe("colours", () => {
		useFullColor();
		it("paints the waiting text in borderAccent and the working text in accent", () => {
			expect(theme.getFgAnsi("borderAccent")).not.toBe(theme.getFgAnsi("accent"));
			const waiting = chip({ peers: 2, working: 1, waiting: 1 }).painted;
			expect(waiting).toContain(theme.fg("borderAccent", `${theme.status.warning} 1 needs you`));
			const working = chip({ peers: 2, working: 1, waiting: 0 }).painted;
			expect(working).toContain(theme.fg("accent", "1 working"));
			expect(working).not.toContain(theme.fg("borderAccent", "1 working"));
			expect(waiting).not.toContain(theme.fg("accent", `${theme.status.warning} 1 needs you`));
		});
	});
});

describe("every status line preset carries the room chip", () => {
	/**
	 * Swept from the preset table, so a preset added without the chip fails
	 * until someone records that decision. Opt-outs are pinned by exact
	 * equality: today there are none.
	 */
	it("has no preset that hides a peer waiting on the operator", () => {
		const presets = Object.entries(STATUS_LINE_PRESETS);
		expect(presets.length).toBeGreaterThan(0);
		const missing = presets
			.filter(([, preset]) => ![...preset.leftSegments, ...preset.rightSegments].includes("room"))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});
});
