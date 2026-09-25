/**
 * WHY: the room view shows what the room last said under its title, but saying
 * something to it meant leaving the view for `/room say`. `s` in the room view
 * opens a line in place of the pager that posts to `#room` as the operator.
 *
 * The class: a say line that leaks into the room or the room into it, and a
 * post that loses what was typed. While the line is open every key the room
 * answers is text or caret movement for the line and does nothing in the room
 * (swept from the same keys as the naming line), and a click chooses nothing;
 * Enter posts the text trimmed and an empty line posts nothing; Esc and a
 * refused post keep the text for the next `s`, a post that went out keeps
 * nothing; a refusal or a post that missed a conversation says so; a room of
 * one neither offers `s` nor opens the line.
 *
 * What it does NOT catch: that the room controller posts through the room's
 * bus as the operator and words its refusals; the claim suite drives that
 * through a real bus, and `/room say`'s suite pins the words.
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
	snapshotOf,
} from "./room-stage-driver";

useTruecolorTheme("dark");

afterEach(() => {
	disposeStages();
});

const PROMPT = [{ kind: "prompt", text: "list the tables" }] as const;
const LABEL = "Say to the room";

async function room(count = 3): Promise<StageDriver> {
	const members = Array.from(
		{ length: count },
		(_, index) =>
			new FakeMember(`m${index + 1}`, snapshotOf({ kind: "done", at: START_MS }, PROMPT), { origin: index === 0 }),
	);
	const driver = new StageDriver({
		width: 160,
		height: 40,
		members,
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

/** The say line as it reads, label and text, or undefined while it is closed. */
function sayLine(driver: StageDriver): string | undefined {
	return driver
		.render()
		.map(row => stripVTControlCharacters(row).trim())
		.find(row => row.startsWith(LABEL));
}

async function type(driver: StageDriver, value: string): Promise<void> {
	for (const char of value) await driver.press(char);
}

describe("s in the room view", () => {
	it("opens a line under the windows, and Enter posts what was typed and gives the pager back", async () => {
		const driver = await room();
		await driver.press(KEY.right);
		await driver.press("s");
		expect(sayLine(driver)).toBe(LABEL);
		expect(keyRow(driver)).toBe("enter post  ·  esc cancel");
		await type(driver, "rebase onto main first @2");
		expect(sayLine(driver)).toBe(`${LABEL}  rebase onto main first @2`);
		await driver.press(KEY.enter);
		expect(driver.host.says).toEqual(["rebase onto main first @2"]);
		const after = driver.render();
		expect(sayLine(driver)).toBeUndefined();
		// The selection the line opened on is where the pager comes back.
		expect(pagerSelection(after, 3)).toBe(1);
	});

	it("posts the text trimmed, and nothing for a line that is empty or blank", async () => {
		const outcomes: Record<string, unknown> = {};
		for (const [name, keys] of Object.entries({
			padded: [" ", " ", "h", "i", " ", KEY.enter],
			empty: [KEY.enter],
			blank: [" ", " ", KEY.enter],
		})) {
			const driver = await room();
			await driver.press("s");
			for (const key of keys) await driver.press(key);
			outcomes[name] = { says: driver.host.says, open: sayLine(driver) !== undefined };
		}
		expect(outcomes).toEqual({
			padded: { says: ["hi"], open: false },
			empty: { says: [], open: false },
			blank: { says: [], open: false },
		});
	});

	/**
	 * A post can be a paragraph, and one Esc must not throw it away: the next
	 * `s` opens with it, the caret after it. What went out is not offered again.
	 */
	it("keeps what Esc left for the next s, and a line that was posted leaves nothing", async () => {
		const driver = await room();
		await driver.press("s");
		await type(driver, "hold the release");
		await driver.press(KEY.escape);
		expect({ says: driver.host.says, line: sayLine(driver) }).toEqual({ says: [], line: undefined });

		await driver.press("s");
		expect(sayLine(driver)).toBe(`${LABEL}  hold the release`);
		await type(driver, "!");
		await driver.press(KEY.enter);
		expect(driver.host.says).toEqual(["hold the release!"]);

		await driver.press("s");
		expect(sayLine(driver)).toBe(LABEL);
	});

	it("says why a post was refused and keeps its text for the next s", async () => {
		const driver = await room();
		const refusal = "A #room post holds at most 4000 characters and this one has 4001; post a file's path instead.";
		driver.host.sayOutcome = { posted: false, notice: refusal };
		await driver.press("s");
		await type(driver, "long");
		await driver.press(KEY.enter);
		expect(text(driver.render())).toContain(refusal);
		expect(sayLine(driver)).toBeUndefined();

		await driver.press("s");
		expect(sayLine(driver)).toBe(`${LABEL}  long`);
	});

	it("says which conversation a post missed, and keeps nothing of a post that went out", async () => {
		const driver = await room();
		const missed = "Posted to #room, but it did not reach conversation 3 (Recipient session is disposed.)";
		driver.host.sayOutcome = { posted: true, notice: missed };
		await driver.press("s");
		await type(driver, "ship it");
		await driver.press(KEY.enter);
		expect(text(driver.render())).toContain(missed);

		await driver.press("s");
		expect(sayLine(driver)).toBe(LABEL);
	});

	it("is neither offered nor opened in a room of one", async () => {
		const alone = await room(1);
		expect(keyRow(alone)).not.toContain("s say");
		await alone.press("s");
		expect(sayLine(alone)).toBeUndefined();

		const two = await room(2);
		expect(keyRow(two)).toContain("s say");
	});

	/**
	 * Every key the room answers, typed while a post is being written: each is
	 * text or caret movement for the line, and the room stays exactly as it
	 * was. A key that also acted would enter, create, close, rename, move the
	 * selection, switch the layout, open the guide or leave.
	 */
	it("gives every room key to the line while a post is typed, and a click chooses nothing", async () => {
		const keys: Record<string, string> = { enterless: "", ...ROOM_KEYS };
		const outcomes: Record<string, unknown> = {};
		for (const [name, data] of Object.entries(keys)) {
			const driver = await room();
			await driver.press("s");
			if (data !== "") await driver.press(data);
			await driver.settle();
			const frame = text(driver.lastFrame);
			const state = {
				saying: frame.includes(LABEL),
				guide: frame.includes("any key closes this"),
				entering: driver.host.prepares.length + driver.host.lands.length,
				creates: driver.host.creates.length,
				closes: driver.host.closes.length,
				renames: driver.host.renames.length,
				says: driver.host.says.length,
				layout: driver.stage.layout,
			};
			// The pager is under the line; Esc gives it back to read the selection.
			await driver.press(KEY.escape);
			outcomes[name] = { ...state, selected: pagerSelection(driver.render(), 3) };
		}
		const untouched = {
			saying: true,
			guide: false,
			entering: 0,
			creates: 0,
			closes: 0,
			renames: 0,
			says: 0,
			selected: 0,
			layout: "side-by-side",
		};
		expect(outcomes).toEqual(Object.fromEntries(Object.keys(keys).map(name => [name, untouched])));
	});
});
