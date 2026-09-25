/**
 * WHY: a room of unnamed conversations reads as `1`, `2`, `3` and their
 * prompts. `/rename` names only the conversation on screen, so naming the
 * others meant going into each one. `r` in the room view names the selected
 * conversation on a line in place of the pager.
 *
 * The class: a naming line that leaks into the room or the room into it. While
 * a name is typed, every key the room answers is text or caret movement for
 * the line and does nothing in the room (swept below from the same keys the
 * guide's sweep presses), and a click chooses nothing; Enter names the
 * conversation the line was opened on, even when the selection could have
 * moved; Esc, an empty name and the name it already has name nothing; a
 * refused name says why. The key row that offers `r` is also the one row that
 * cannot hold every key on a narrow terminal, so the order in which its hints
 * give way is pinned: the least used first, `?` and the way out last.
 *
 * What it does NOT catch: that the room controller stores the name on the
 * session; the claim suite drives that through a real session.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { roomGuide } from "@veyyon/coding-agent/modes/terminal/components/room/room-guide";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import {
	disposeStages,
	FakeMember,
	KEY,
	pagerSelection,
	ROOM_KEYS,
	START_MS,
	StageDriver,
	sgrMouse,
	snapshotOf,
} from "./room-stage-driver";

useTruecolorTheme("dark");

afterEach(() => {
	disposeStages();
});

const PROMPT = [{ kind: "prompt", text: "list the tables" }] as const;

function roster(): FakeMember[] {
	return [
		new FakeMember("m1", snapshotOf({ kind: "done", at: START_MS }, PROMPT, { title: "tables" }), { origin: true }),
		new FakeMember("m2", snapshotOf({ kind: "done", at: START_MS }, PROMPT)),
		new FakeMember("m3", snapshotOf({ kind: "done", at: START_MS }, PROMPT, { title: "columns" })),
	];
}

async function room(width = 160): Promise<StageDriver> {
	const driver = new StageDriver({
		width,
		height: 40,
		members: roster(),
		motion: false,
		guide: roomGuide({ view: "alt+w", next: "alt+.", previous: "alt+," }),
	});
	await driver.settle();
	return driver;
}

function text(rows: readonly string[]): string {
	return rows.map(row => stripVTControlCharacters(row)).join("\n");
}

function keyRow(driver: StageDriver): string {
	return stripVTControlCharacters(driver.render().at(-1) ?? "").trim();
}

async function type(driver: StageDriver, value: string): Promise<void> {
	for (const char of value) await driver.press(char);
}

describe("r in the room view", () => {
	it("opens a line holding the selected conversation's name, and Enter names it with what was typed", async () => {
		const driver = await room();
		await driver.press(KEY.right);
		await driver.press(KEY.right);
		await driver.press("r");
		const naming = text(driver.render());
		expect(naming).toContain("Name conversation 3  columns");
		expect(keyRow(driver)).toBe("enter save  ·  esc cancel");
		await type(driver, "schema");
		await driver.press(KEY.enter);
		expect(driver.host.renames).toEqual([{ id: "m3", name: "schema" }]);
		// The line gives the pager back, and the window reads its new name.
		const after = driver.render();
		expect(text(after)).not.toContain("Name conversation");
		expect(pagerSelection(after, 3)).toBe(2);
		expect(text(after)).toContain("3  schema");
	});

	/**
	 * The name the line opens with is held the way a rename field holds a
	 * file's name: the first character typed replaces it and the first
	 * backspace clears it, while a key that moves the caret keeps it to edit.
	 */
	it("replaces the name it holds on the first character or backspace, and keeps it after a caret key", async () => {
		const outcomes: Record<string, unknown> = {};
		for (const [name, keys] of Object.entries({
			typed: ["s", "q", "l"],
			pasted: ["\x1b[200~sql\x1b[201~"],
			backspaceThenTyped: ["\x7f", "s", "q", "l"],
			endThenTyped: [KEY.end, " ", "2"],
			homeThenTyped: [KEY.home, "o", "l", "d", " "],
			leftThenBackspace: [KEY.left, "\x7f"],
		})) {
			const driver = await room();
			await driver.press("r");
			for (const key of keys) await driver.press(key);
			await driver.press(KEY.enter);
			outcomes[name] = driver.host.renames.map(rename => rename.name);
		}
		expect(outcomes).toEqual({
			typed: ["sql"],
			pasted: ["sql"],
			backspaceThenTyped: ["sql"],
			endThenTyped: ["tables 2"],
			homeThenTyped: ["old tables"],
			leftThenBackspace: ["tabls"],
		});
	});

	it("starts empty on a conversation with no name", async () => {
		const driver = await room();
		await driver.press(KEY.right);
		await driver.press("r");
		expect(text(driver.render())).toContain("Name conversation 2");
		await type(driver, "schema");
		await driver.press(KEY.enter);
		expect(driver.host.renames).toEqual([{ id: "m2", name: "schema" }]);
	});

	it("names nothing on Esc, on an empty name, or on the name it already has", async () => {
		const outcomes: Record<string, unknown> = {};
		for (const [name, keys] of Object.entries({
			escape: ["x", KEY.escape],
			empty: ["\x7f", KEY.enter],
			spaces: [" ", " ", KEY.enter],
			unchanged: [KEY.enter],
			retyped: ["t", "a", "b", "l", "e", "s", KEY.enter],
		})) {
			const driver = await room();
			await driver.press("r");
			for (const key of keys) await driver.press(key);
			outcomes[name] = {
				renames: driver.host.renames.length,
				naming: text(driver.render()).includes("Name conversation"),
			};
		}
		const nothing = { renames: 0, naming: false };
		expect(outcomes).toEqual({
			escape: nothing,
			empty: nothing,
			spaces: nothing,
			unchanged: nothing,
			retyped: nothing,
		});
	});

	it("says why a name was refused", async () => {
		const driver = await room();
		driver.host.renameRefusal = "That conversation has already closed.";
		await driver.press("r");
		await type(driver, "s");
		await driver.press(KEY.enter);
		expect(text(driver.render())).toContain("That conversation has already closed.");
	});

	it("does nothing on the + slot", async () => {
		const driver = await room();
		await driver.press(KEY.end);
		await driver.press("r");
		expect(text(driver.render())).not.toContain("Name conversation");
		expect(keyRow(driver)).toContain("r rename");
	});

	/**
	 * Every key the room answers, typed while a name is being written: each is
	 * text or caret movement for the line, and the room stays exactly as it
	 * was. A key that also acted would enter, create, close, move the selection,
	 * switch the layout, open the guide or leave.
	 */
	it("gives every room key to the line while a name is typed, and a click chooses nothing", async () => {
		const keys: Record<string, string> = { enterless: "", ...ROOM_KEYS };
		const outcomes: Record<string, unknown> = {};
		for (const [name, data] of Object.entries(keys)) {
			const driver = await room();
			await driver.press("r");
			if (data !== "") await driver.press(data);
			await driver.settle();
			outcomes[name] = {
				naming: text(driver.lastFrame).includes("Name conversation 1"),
				guide: text(driver.lastFrame).includes("any key closes this"),
				entering: driver.host.prepares.length + driver.host.lands.length,
				creates: driver.host.creates.length,
				closes: driver.host.closes.length,
				renames: driver.host.renames.length,
				says: driver.host.says.length,
				layout: driver.stage.layout,
			};
		}
		const untouched = {
			naming: true,
			guide: false,
			entering: 0,
			creates: 0,
			closes: 0,
			renames: 0,
			says: 0,
			layout: "side-by-side",
		};
		expect(outcomes).toEqual(Object.fromEntries(Object.keys(keys).map(name => [name, untouched])));
	});

	it("names the conversation the line was opened on", async () => {
		const driver = await room();
		await driver.press("r");
		await driver.press(sgrMouse(65, 80, 20));
		await driver.press(KEY.right);
		await type(driver, "!");
		await driver.press(KEY.enter);
		expect(driver.host.renames.map(rename => rename.id)).toEqual(["m1"]);
	});
});

describe("the room view's key row", () => {
	/**
	 * Narrowing the terminal one column at a time, the order in which hints
	 * leave the row: the digit jump, then saying to the room, naming, closing,
	 * the layout switch and a new conversation, then Esc, then the guide, whose
	 * card names every key the row dropped, then Enter. The hints that stay
	 * keep their order.
	 */
	it("drops the key that matters least first, and keeps the guide and the way out longest", async () => {
		const order = [
			"←→ move",
			"enter open",
			"1–3 jump",
			"n new",
			"x close",
			"r rename",
			"s say",
			"tab all windows",
			"esc back to 1",
			"? guide",
		];
		const dropped: string[] = [];
		let shown = order;
		for (let width = 160; width >= 20; width--) {
			const driver = await room(width);
			const now = keyRow(driver)
				.split("  ·  ")
				.map(hint => hint.trim());
			expect(now).toEqual(order.filter(hint => now.includes(hint)));
			for (const hint of shown) if (!now.includes(hint)) dropped.push(hint);
			shown = now;
			disposeStages();
		}
		expect(dropped).toEqual([
			"1–3 jump",
			"s say",
			"r rename",
			"x close",
			"tab all windows",
			"n new",
			"esc back to 1",
			"? guide",
			"enter open",
		]);
	});
});
