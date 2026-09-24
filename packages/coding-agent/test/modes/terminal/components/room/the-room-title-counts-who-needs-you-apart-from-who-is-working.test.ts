/**
 * WHY: the room view's title row counted a conversation holding a question as
 * working and as needing you, so two conversations read `2 working · 1 needs
 * you`, and it named the working ones first, the other way round from the
 * status line's room segment. The key row offered no way to jump by number,
 * though the digits have always worked.
 *
 * The contract: a waiting conversation is counted once, as needing you, ahead
 * of the working ones, the way the status line reads it; the key row names the
 * digit jump with the digits the room takes, only when there is somewhere to
 * jump; Enter reads `answer` while the window in front holds a question,
 * `open` otherwise, following the selection; Esc names the conversation the
 * view was opened from, wherever the selection has gone; a window holding
 * a question keeps the ember of a waiting prompt in its frame, a blend toward
 * the ground short of the selection's full ember, so it stands apart from both
 * the selected window and a quiet one; and an idle window whose answer nobody
 * has read is counted after the work and marks its ordinal with how its turn
 * ended, while one that is working again or holding a question is counted as
 * that instead.
 *
 * What it does NOT catch: the colours of the title and key rows, or which hints
 * a narrow terminal drops (the frame sweeps pin that every row fits).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { paintRoomWindow } from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { parseHexColor } from "@veyyon/utils/paint-ground";
import { useFullColor, useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { rowCells } from "./room-frame-oracle";
import { disposeStages, FakeMember, KEY, START_MS, StageDriver, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const WORKING = snapshotOf({ kind: "working", since: START_MS, activity: "writing" }, [
	{ kind: "prompt", text: "write the migration" },
]);
const DONE = snapshotOf({ kind: "done", at: START_MS }, [{ kind: "prompt", text: "list the tables" }]);
const FAILED = snapshotOf({ kind: "failed", reason: "overloaded" }, [{ kind: "prompt", text: "run the suite" }]);

/** Every read state an unread flag can meet: finished, failed, working again, holding a question. */
function unreadRoom(): FakeMember[] {
	return [
		new FakeMember("m1", DONE, { origin: true }),
		new FakeMember("m2", DONE, { unread: true }),
		new FakeMember("m3", FAILED, { unread: true }),
		new FakeMember("m4", WORKING, { unread: true }),
		new FakeMember("m5", DONE, { unread: true, waitingDialogs: 1 }),
	];
}

function settledRows(members: FakeMember[]): string[] {
	const driver = new StageDriver({ width: 160, height: 40, members, motion: false });
	return [...driver.render()].map(row => stripVTControlCharacters(row));
}

describe("the room view's title row", () => {
	afterEach(() => {
		disposeStages();
	});

	it("counts a conversation holding a question as needing you, not also as working, and names it first", () => {
		const rows = settledRows([
			new FakeMember("m1", DONE, { origin: true }),
			new FakeMember("m2", WORKING, { waitingDialogs: 1 }),
			new FakeMember("m3", WORKING),
		]);
		expect(rows[0]).toMatch(/3 conversations {2}· {2}\S+ 1 needs you {2}· {2}1 working/);
	});

	it("says nothing about attention when nobody is waiting or working", () => {
		const rows = settledRows([new FakeMember("m1", DONE, { origin: true }), new FakeMember("m2", DONE)]);
		expect(rows[0]).not.toContain("needs you");
		expect(rows[0]).not.toContain("working");
	});

	it("counts an unread answer after the work, and a window working again or holding a question as that", () => {
		const rows = settledRows(unreadRoom());
		expect(rows[0]).toMatch(/5 conversations {2}· {2}\S+ 1 needs you {2}· {2}1 working {2}· {2}2 unread/);
	});

	it("marks the ordinal under an unread window with how its turn ended", () => {
		const pager = settledRows(unreadRoom())[37]?.trim().split(/\s+/);
		expect(pager).toEqual([
			"1",
			`2${theme.status.success}`,
			`3${theme.status.error}`,
			"4",
			`5${theme.status.warning}`,
			"+",
		]);
	});
});

describe("the room view's key row", () => {
	afterEach(() => {
		disposeStages();
	});

	it("names the digit jump with the digits the room takes", () => {
		const rows = settledRows([
			new FakeMember("m1", DONE, { origin: true }),
			new FakeMember("m2", DONE),
			new FakeMember("m3", DONE),
		]);
		expect(rows.at(-1)).toContain("1–3 jump");
	});

	it("does not offer a jump in a room of one", () => {
		const rows = settledRows([new FakeMember("m1", DONE, { origin: true })]);
		expect(rows.at(-1)).not.toContain("jump");
	});

	it("says enter answers while the window in front holds a question, and opens otherwise", async () => {
		const driver = new StageDriver({
			width: 160,
			height: 40,
			members: [new FakeMember("m1", DONE, { origin: true }), new FakeMember("m2", WORKING, { waitingDialogs: 1 })],
			motion: false,
		});
		const keys = (): string => stripVTControlCharacters(driver.render().at(-1) ?? "");
		expect(keys()).toContain("enter open");
		await driver.press(KEY.right);
		expect(keys()).toContain("enter answer");
		await driver.press(KEY.right);
		expect(keys()).toContain("enter open");
	});

	it("names the conversation Esc goes back to, wherever the selection moves, and only says back in a room of one", async () => {
		const driver = new StageDriver({
			width: 160,
			height: 40,
			members: [
				new FakeMember("m1", DONE),
				new FakeMember("m2", DONE, { origin: true }),
				new FakeMember("m3", DONE),
			],
			originId: "m2",
			motion: false,
		});
		const keys = (): string => stripVTControlCharacters(driver.render().at(-1) ?? "");
		expect(keys()).toContain("esc back to 2");
		await driver.press(KEY.right);
		expect(keys()).toContain("esc back to 2");
		await driver.press(KEY.home);
		expect(keys()).toContain("esc back to 2");

		const alone = settledRows([new FakeMember("m1", DONE, { origin: true })]).at(-1) ?? "";
		expect(alone).toContain("esc back");
		expect(alone).not.toContain("back to");
	});
});

describe("a waiting window's frame", () => {
	useFullColor();

	function frameCorner(waitingDialogs: number, selected: boolean): string {
		const rows = paintRoomWindow({
			width: 60,
			height: 12,
			snapshot: WORKING,
			ordinal: 2,
			strength: 1,
			selected,
			framed: true,
			waitingDialogs,
			now: START_MS,
		});
		return rowCells(rows[0] ?? "")[0]?.style ?? "";
	}

	/** The truecolor foreground of a cell style as the frame oracle reports it (`fg=2;r;g;b`). */
	function foreground(style: string): { r: number; g: number; b: number } {
		const match = /fg=2;(\d+);(\d+);(\d+)/.exec(style);
		if (!match) throw new Error(`no truecolor foreground in ${JSON.stringify(style)}`);
		return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
	}

	it("stands apart from a quiet window and from the selected one", () => {
		const styles = new Set([frameCorner(1, false), frameCorner(0, false), frameCorner(0, true)]);
		expect(styles.size).toBe(3);
	});

	it("is the ember of a waiting prompt blended toward the ground, short of the selection's", () => {
		const ember = parseHexColor(theme.getColorHex("borderAccent"));
		const ground = parseHexColor(theme.visibleGroundHex());
		if (!ember || !ground) throw new Error("expected hex colours for the ember and the ground");
		const waiting = foreground(frameCorner(1, false));
		// Each channel sits the same fraction of the way from the ground to the ember.
		const fractions = (["r", "g", "b"] as const)
			.filter(channel => Math.abs(ember[channel] - ground[channel]) > 8)
			.map(channel => (waiting[channel] - ground[channel]) / (ember[channel] - ground[channel]));
		expect(fractions.length).toBeGreaterThan(0);
		for (const fraction of fractions) {
			expect(fraction).toBeGreaterThan(0.2);
			expect(fraction).toBeLessThan(0.95);
			expect(Math.abs(fraction - fractions[0]!)).toBeLessThan(0.05);
		}
	});

	it("gives way to the selection's frame on the selected window", () => {
		expect(frameCorner(1, true)).toBe(frameCorner(0, true));
	});
});
