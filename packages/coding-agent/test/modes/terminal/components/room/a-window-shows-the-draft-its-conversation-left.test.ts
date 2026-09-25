/**
 * WHY: the room keeps each conversation's unsent draft, text and attachments,
 * while another conversation has the composer. A window that did not show it
 * hid work the room was keeping: text typed for a conversation, then left for
 * another one, was out of sight until the operator happened to go back.
 *
 * The class: a draft reaches its window's foot as `✎ draft · <first line> ·
 * <attachments>`; the line is cut before the attachment count; a draft that is
 * only attachments still shows; a question waiting for an answer keeps the last
 * row and the draft sits above it, and when the window has room for one of
 * them the question is the one that stays; a window with no draft, or too
 * narrow for its words, has no draft row; a window on the stage draws its
 * member's draft and repaints on the frame after the draft changes. The glyph
 * and the separator are read from the active theme, so another symbol preset
 * is covered by the same assertions. The frame suite sweeps a draft of wide
 * glyphs through every window size.
 *
 * What it does NOT catch: which draft a member reports (the room controller's
 * claim suite drives that through real sessions), and the colours.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RoomDraft } from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { paintRoomWindow } from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { FakeMember, StageDriver, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const NOW = Date.UTC(2026, 8, 23, 14, 5, 0);
const DONE = snapshotOf({ kind: "done", at: NOW - 60_000 }, [
	{ kind: "prompt", text: "split the tokenizer out of the parser" },
	{ kind: "text", text: "Done: the tokenizer is its own module now." },
]);

/** The rows inside the frame, as plain text with the padding trimmed. */
function inside(width: number, height: number, draft: RoomDraft | undefined, waitingDialogs = 0): string[] {
	const rows = paintRoomWindow({
		width,
		height,
		snapshot: DONE,
		ordinal: 2,
		strength: 1,
		selected: false,
		framed: true,
		waitingDialogs,
		draft,
		now: NOW,
	}).map(row => stripVTControlCharacters(row));
	return rows.slice(1, -1).map(row => row.slice(2, -2).trimEnd());
}

function draftWords(...parts: string[]): string {
	return `${theme.symbol("tool.edit")} ${["draft", ...parts].join(theme.sep.dot)}`;
}

describe("a window's draft", () => {
	it("sits at the foot as its first line and what it has attached", () => {
		const foot = inside(80, 14, { line: "explain the second fact", images: 1, files: 2 }).at(-1);
		expect(foot).toBe(draftWords("explain the second fact", "1 image", "2 files"));
	});

	it("cuts its line before what it has attached", () => {
		const line = "rewrite the whole parser so that every token carries its source span and its trivia";
		const foot = inside(48, 14, { line, images: 2, files: 0 }).at(-1) ?? "";
		expect(foot.endsWith(`${theme.sep.dot}2 images`)).toBe(true);
		expect(foot.startsWith(draftWords("rewrite"))).toBe(true);
		expect(foot).toContain("…");
	});

	it("shows a draft that is only attachments", () => {
		expect(inside(80, 14, { line: "", images: 1, files: 0 }).at(-1)).toBe(draftWords("1 image"));
	});

	it("sits above a question waiting for an answer, which keeps the last row", () => {
		const rows = inside(80, 14, { line: "explain this", images: 0, files: 0 }, 1);
		expect(rows.slice(-2)).toEqual([draftWords("explain this"), `${theme.status.warning} waiting for your answer`]);
	});

	it("gives way to a waiting question when the window has room for one of them", () => {
		// Four rows inside: two for the body, a blank, and one foot row.
		const rows = inside(80, 6, { line: "explain this", images: 0, files: 0 }, 1);
		expect(rows.at(-1)).toBe(`${theme.status.warning} waiting for your answer`);
		expect(rows.some(row => row.includes("draft"))).toBe(false);
	});

	it("has no row in a window with no draft, or one too narrow for its words", () => {
		expect(inside(80, 14, undefined).some(row => row.includes("draft"))).toBe(false);
		expect(inside(13, 14, { line: "explain this", images: 0, files: 0 }).some(row => row.includes("draft"))).toBe(
			false,
		);
	});
});

describe("a window on the stage", () => {
	/**
	 * The stage reuses a window's last paint while nothing it was painted from
	 * changed. A draft is one of those inputs: a paint cache blind to it would
	 * keep drawing the draft the window had when it was first painted.
	 */
	it("draws its member's draft, and a draft that changes is drawn on the next frame", async () => {
		const members = [
			new FakeMember("m0", DONE, { origin: true }),
			new FakeMember("m1", DONE, { draft: { line: "first thought", images: 0, files: 0 } }),
		];
		const stage = new StageDriver({ width: 120, height: 40, members, layout: "all-windows", motion: false });
		await stage.settle();
		const text = (): string => stage.lastFrame.map(row => stripVTControlCharacters(row)).join("\n");
		expect(text()).toContain(draftWords("first thought"));
		members[1]!.draft = { line: "second thought", images: 0, files: 0 };
		stage.render();
		expect(text()).toContain(draftWords("second thought"));
		expect(text()).not.toContain("first thought");
	});
});
