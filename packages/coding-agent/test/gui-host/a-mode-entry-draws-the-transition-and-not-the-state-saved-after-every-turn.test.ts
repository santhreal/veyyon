/**
 * WHY: the goal and loop runtimes record their state through a `mode_change`
 * entry after every completed turn and every token reading, not only when the
 * mode changes. The desktop drew one row per entry, so a goal running twelve
 * turns filed twelve `Mode: goal` notes into the transcript between the
 * prompt and the reply, each stating the mode the one above it already stated.
 *
 * CLASS CLOSED: a state save drawn as a transition. The variant space is the
 * `SessionEntry` union, swept from the fixture map the type checker holds
 * exhaustive: the suite pins by exact equality the set of kinds that read the
 * mode in force ahead of them, so a second kind that starts reading it turns
 * red until the decision is recorded. Beside the sweep, the three seams that
 * carry a mode to the desktop: the stored list, the live append, and the seed
 * a reattach reads off a session that is already in a mode.
 *
 * The dedup is against the entry immediately ahead, never against every mode
 * seen, so a run that leaves a mode and returns to it draws both crossings.
 *
 * NOT CAUGHT: the words the desktop draws a mode with, which
 * `crates/veyyon-desktop/tests/a-transcript-projects-as-turns-of-blocks.rs`
 * holds, and whether the runtime should write the state save at all, which is
 * the goal driver's own contract.
 */

import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import {
	appendedEntryToTranscriptEntry,
	type FirstMessagePosition,
	seedFirstMessagePosition,
	sessionEntriesToTranscript,
	sessionEntryToTranscriptEntry,
} from "../../src/gui-host/transcript-conversion";
import type { ContentBlock } from "../../src/gui-host/wire";
import { EXHAUSTIVE_FIXTURES, FIXTURE_TIMESTAMP } from "./transcript-conversion-fixtures";

/** The kinds whose blocks read differently for the mode in force ahead of them. */
const READS_THE_PRECEDING_MODE = ["mode_change"];

/** The mode the `mode_change` fixture records, which the sweep holds against it. */
const FIXTURE_MODE = "plan";

let next = 0;

function modeChange(mode: string): SessionEntry {
	next += 1;
	return {
		type: "mode_change",
		id: `entry-mode-${next}`,
		parentId: null,
		timestamp: FIXTURE_TIMESTAMP,
		mode,
	};
}

function prompt(text: string): SessionEntry {
	next += 1;
	return {
		type: "message",
		id: `entry-msg-${next}`,
		parentId: null,
		timestamp: FIXTURE_TIMESTAMP,
		message: { role: "user", content: text, timestamp: Date.parse(FIXTURE_TIMESTAMP) },
	};
}

/** The modes the blocks of a converted list state, in the order they draw. */
function modesDrawn(entries: readonly { content: ContentBlock[] }[]): string[] {
	const modes: string[] = [];
	for (const entry of entries) {
		for (const block of entry.content) {
			if ("ModeChange" in block) modes.push(block.ModeChange.mode);
		}
	}
	return modes;
}

describe("the mode in force ahead of an entry", () => {
	test("only a mode entry reads it", () => {
		// The fixture map is `satisfies Record<SessionEntry["type"], ...>`, so
		// this sweep is the union: a kind added to it appears here without an
		// edit, and a kind added to the union without a fixture fails the type
		// check over there.
		const differs: string[] = [];
		for (const [kind, fixture] of Object.entries(EXHAUSTIVE_FIXTURES)) {
			const alone = sessionEntryToTranscriptEntry(fixture.entry, 1, { beforeFirstMessage: false });
			const after = sessionEntryToTranscriptEntry(fixture.entry, 1, {
				beforeFirstMessage: false,
				precedingMode: FIXTURE_MODE,
			});
			if (JSON.stringify(alone.content) !== JSON.stringify(after.content)) differs.push(kind);
		}
		expect(differs).toEqual(READS_THE_PRECEDING_MODE);
	});

	test("a mode entry naming a different mode draws the crossing", () => {
		const entry = modeChange("goal");
		const converted = sessionEntryToTranscriptEntry(entry, 1, {
			beforeFirstMessage: false,
			precedingMode: "plan",
		});
		expect(converted.content).toEqual([{ ModeChange: { mode: "goal" } }]);
	});

	test("a suppressed state save keeps its identity, its place and its record", () => {
		// It draws nothing; it is still an entry, and the ledger the desktop
		// files it under, the audit copy and the parent chain are what a later
		// reload and an export read.
		const entry = modeChange("goal");
		const converted = sessionEntryToTranscriptEntry(entry, 9, {
			beforeFirstMessage: false,
			precedingMode: "goal",
		});
		expect(converted.content).toEqual([]);
		expect(converted.id).toBe(entry.id);
		expect(converted.revision).toBe(9);
		expect(converted.raw_discriminator).toBe("mode_change");
		expect(converted.raw).toBe(entry);
	});
});

describe("a stored transcript of a goal run", () => {
	test("draws one row per crossing and none per turn", () => {
		const entries = [
			prompt("ship the desktop parity work"),
			modeChange("goal"),
			modeChange("goal"),
			modeChange("goal"),
			modeChange("goal_paused"),
			modeChange("goal_paused"),
			modeChange("none"),
		];
		const converted = sessionEntriesToTranscript(entries, 1);
		expect(modesDrawn(converted)).toEqual(["goal", "goal_paused", "none"]);
		expect(converted.map(entry => entry.content.length)).toEqual([1, 1, 0, 0, 1, 0, 1]);
	});

	test("draws a mode the run left and returned to", () => {
		// The rule is the entry immediately ahead, not every mode the session
		// has been in: a dedup that remembered the set would draw the return
		// as another state save and lose the crossing.
		const entries = [modeChange("goal"), modeChange("none"), modeChange("goal")];
		expect(modesDrawn(sessionEntriesToTranscript(entries, 1))).toEqual(["goal", "none", "goal"]);
	});

	test("draws the mode a session opens in", () => {
		// Nothing is in force ahead of the first entry, so the first mode a
		// session records is a crossing out of the default and draws.
		const entries = [modeChange("goal"), prompt("ship it")];
		expect(modesDrawn(sessionEntriesToTranscript(entries, 1))).toEqual(["goal"]);
	});
});

describe("the seam a live entry converts through", () => {
	test("a state save appended after a crossing draws nothing", () => {
		const position: FirstMessagePosition = {};
		const drawn = [modeChange("goal"), modeChange("goal"), modeChange("goal_paused")].map(entry =>
			appendedEntryToTranscriptEntry(position, entry, 1),
		);
		expect(modesDrawn(drawn)).toEqual(["goal", "goal_paused"]);
	});

	test("a reattach reads the mode the session is already in", () => {
		// Without the seed the first entry after a reattach has nothing ahead
		// of it, so a window rejoining a goal run mid-flight drew a `goal` row
		// for the next turn's state save.
		const stored = [prompt("ship it"), modeChange("goal"), modeChange("goal")];
		const position: FirstMessagePosition = {};
		seedFirstMessagePosition(position, stored);
		expect(position.lastMode).toBe("goal");

		const save = appendedEntryToTranscriptEntry(position, modeChange("goal"), 2);
		expect(save.content).toEqual([]);
		const crossing = appendedEntryToTranscriptEntry(position, modeChange("none"), 3);
		expect(crossing.content).toEqual([{ ModeChange: { mode: "none" } }]);
	});

	test("a seed over a session that recorded no mode leaves the first one drawing", () => {
		const position: FirstMessagePosition = { lastMode: "goal" };
		seedFirstMessagePosition(position, [prompt("ship it")]);
		expect(position.lastMode).toBeUndefined();
		const first = appendedEntryToTranscriptEntry(position, modeChange("plan"), 2);
		expect(first.content).toEqual([{ ModeChange: { mode: "plan" } }]);
	});
});
