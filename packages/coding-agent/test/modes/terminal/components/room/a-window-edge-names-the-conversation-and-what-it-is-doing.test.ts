/**
 * WHY: the top edge of a room window is what a glance at the room reads. It
 * said `working` for every kind of work, so a conversation thinking, writing
 * and running a test suite looked the same; it said `done` with no time, so
 * two finished conversations could not be told apart; and a conversation with
 * no name was named by its prompt on the edge and again in the body.
 *
 * The class: every activity the feed reports reaches the edge in words, every
 * finished window says when, and the edge never repeats the body. The activity
 * sweep reads `ROOM_ACTIVITIES` at run time and the expected words are a
 * `Record` over it, so a new activity fails to compile until it has words and
 * fails here until they reach the edge.
 *
 * What it does NOT catch: the words on a window too narrow for them, where the
 * edge keeps the state glyph (pinned by the frame sweeps), and the colours.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	ROOM_ACTIVITIES,
	type RoomActivity,
	type RoomFeedBlock,
	type RoomWindowState,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { paintRoomWindow } from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const NOW = Date.UTC(2026, 8, 23, 14, 5, 0);
const PROMPT_TEXT = "split the tokenizer out of the parser";
const PROMPT: RoomFeedBlock = { kind: "prompt", text: PROMPT_TEXT };
const RUNNING_TOOL: RoomFeedBlock = { kind: "tool", label: "bash", detail: "bun test", state: "running" };

/** The words each activity puts on the edge; `tool` names the call it is running. */
const ACTIVITY_WORDS: Record<RoomActivity, string> = {
	starting: "starting",
	thinking: "thinking",
	writing: "writing",
	tool: "running bash",
	compacting: "compacting",
	retrying: "retrying",
};

function paint(state: RoomWindowState, blocks: readonly RoomFeedBlock[], title?: string): string[] {
	return paintRoomWindow({
		width: 100,
		height: 12,
		snapshot: snapshotOf(state, blocks, { title }),
		ordinal: 2,
		strength: 1,
		selected: false,
		framed: true,
		waitingDialogs: 0,
		now: NOW,
	}).map(row => stripVTControlCharacters(row));
}

function edge(rows: readonly string[]): string {
	return rows[0] ?? "";
}

/** `14:05` for `at`, in the zone the painter reads. */
function clockOf(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

describe("a room window's top edge", () => {
	it("covers every activity the feed can report", () => {
		expect(Object.keys(ACTIVITY_WORDS).sort()).toEqual([...ROOM_ACTIVITIES].sort());
	});

	for (const activity of ROOM_ACTIVITIES) {
		it(`names the activity ${activity}, with the turn's clock`, () => {
			const rows = paint({ kind: "working", since: NOW - 41_000, activity }, [PROMPT, RUNNING_TOOL]);
			expect(edge(rows)).toContain(`${ACTIVITY_WORDS[activity]} 0:41`);
		});
	}

	it("says running without a name when the running call is not in the feed yet", () => {
		const rows = paint({ kind: "working", since: NOW, activity: "tool" }, [PROMPT]);
		expect(edge(rows)).toContain("running 0:00");
	});

	it("says when a finished conversation finished, and the same thing an hour later", () => {
		const at = NOW - 3 * 60_000;
		const first = paint({ kind: "done", at }, [PROMPT]);
		expect(edge(first)).toContain(`done ${clockOf(at)}`);
		const later = paintRoomWindow({
			width: 100,
			height: 12,
			snapshot: snapshotOf({ kind: "done", at }, [PROMPT]),
			ordinal: 2,
			strength: 1,
			selected: false,
			framed: true,
			waitingDialogs: 0,
			now: NOW + 3_600_000,
		}).map(row => stripVTControlCharacters(row));
		expect(later).toEqual(first);
	});

	it("carries a named conversation's name", () => {
		expect(edge(paint({ kind: "done", at: NOW }, [PROMPT], "parser rewrite"))).toContain("2  parser rewrite");
	});

	it("does not repeat the prompt of a conversation with no name, which the body leads with", () => {
		const rows = paint({ kind: "done", at: NOW }, [PROMPT]);
		expect(edge(rows)).not.toContain(PROMPT_TEXT);
		expect(rows[1]).toContain(`› ${PROMPT_TEXT}`);
	});

	it("calls a conversation nothing was asked of a new conversation", () => {
		expect(edge(paint({ kind: "new" }, []))).toContain("2  New conversation");
	});
});
