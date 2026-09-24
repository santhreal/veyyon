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
 * jump; and Enter reads `answer` while the window in front holds a question,
 * `open` otherwise, following the selection.
 *
 * What it does NOT catch: the colours of either row, or which hints a narrow
 * terminal drops (the frame sweeps pin that every row fits).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { disposeStages, FakeMember, KEY, START_MS, StageDriver, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const WORKING = snapshotOf({ kind: "working", since: START_MS, activity: "writing" }, [
	{ kind: "prompt", text: "write the migration" },
]);
const DONE = snapshotOf({ kind: "done", at: START_MS }, [{ kind: "prompt", text: "list the tables" }]);

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
});
