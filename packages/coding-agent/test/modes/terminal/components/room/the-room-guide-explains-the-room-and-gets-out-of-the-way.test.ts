/**
 * WHY THIS SUITE EXISTS.
 *
 * The room view's guide is the first thing a new user sees of the room: a card
 * over the dimmed windows that says what a room is, which keys move through it
 * and what each mark on a window means. It is only worth showing if it gets out
 * of the way the moment it is read. The defect class is a guide that acts as
 * part of the room: a key that dismisses it and also does what it does in the
 * room (Enter carrying the reader into a window, Esc leaving the view, `n`
 * opening a conversation, `x` arming a close, `r` opening a name to type), a
 * click that closes it and picks the window under it, a guide that cannot be
 * brought back or that `?` opens on a stage with nothing to show, a card that
 * overflows a small terminal, a key row that still offers keys that no longer
 * do anything, and a quick switch that opens behind a guide.
 *
 * Every key the room answers is swept against a stage opened with its guide,
 * each on a fresh stage, and checked for exactly one effect: the guide is gone
 * and the room is as it was. The card is rendered at every size in a grid down
 * to a terminal too small for it, and every frame's rows are checked to be the
 * terminal's width.
 *
 * WHAT IT DOES NOT CATCH. That the room view opens with the guide the first
 * time and not after: the room controller suite owns that flag. How the card
 * reads at a glance: the recorded scene shows it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type RoomGuide,
	roomGuide,
	roomGuideMarkdown,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-guide";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { visibleWidth } from "@veyyon/utils/width";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { rowCells } from "./room-frame-oracle";
import {
	disposeStages,
	FakeMember,
	KEY,
	pagerSelection,
	START_MS,
	StageDriver,
	selectedWindowEdge,
	sgrMouse,
	snapshotOf,
} from "./room-stage-driver";

useTruecolorTheme("dark");

afterEach(() => {
	disposeStages();
});

/** Built after the theme is set: the marks it names are the theme's glyphs. */
function guide(): RoomGuide {
	return roomGuide({ view: "alt+w", next: "alt+.", previous: "alt+," });
}
const CLOSES = "any key closes this";
const DONE = snapshotOf({ kind: "done", at: START_MS - 1_000 }, [{ kind: "prompt", text: "a finished question" }]);
const WORKING = snapshotOf({ kind: "working", since: START_MS - 5_000, activity: "writing" }, [
	{ kind: "prompt", text: "a question in progress" },
]);

function roster(): FakeMember[] {
	return [new FakeMember("m0", DONE, { origin: true }), new FakeMember("m1", WORKING), new FakeMember("m2", DONE)];
}

function text(rows: readonly string[]): string {
	return rows.map(row => stripVTControlCharacters(row)).join("\n");
}

async function stage(options: { showGuide?: boolean; guide?: boolean; width?: number; height?: number } = {}) {
	const driver = new StageDriver({
		width: options.width ?? 120,
		height: options.height ?? 40,
		members: roster(),
		motion: false,
		guide: options.guide === false ? undefined : guide(),
		showGuide: options.showGuide ?? true,
	});
	await driver.settle();
	return driver;
}

describe("the room guide", () => {
	it("opens over the room with what a room is, the keys to move through it, its marks and how to close it", async () => {
		const shown = text((await stage()).lastFrame);
		expect(shown).toContain("The room");
		expect(shown).toContain("A room is every conversation in this terminal.");
		// At full size the card cuts nothing: every key and every meaning reads whole.
		for (const section of guide().sections) {
			expect(shown).toContain(section.title);
			for (const row of section.rows) {
				expect(shown).toContain(row.keys);
				expect(shown).toContain(row.text);
			}
		}
		expect(shown).toContain(CLOSES);
		// While it shows, the key row says the one thing a key does.
		expect(stripVTControlCharacters((await stage()).lastFrame.at(-1) ?? "").trim()).toBe("any key close the guide");
	});

	it("dims the windows behind it, and gives their ink back when it goes", async () => {
		const driver = await stage();
		const corner = (): string => {
			const edge = selectedWindowEdge(driver.lastFrame, 1);
			if (!edge) throw new Error("the selected window's top edge is not on the frame");
			return rowCells(driver.lastFrame[edge.y]!)[edge.x]!.style;
		};
		const dimmed = corner();
		await driver.press(KEY.escape);
		await driver.settle();
		expect(corner()).not.toBe(dimmed);
	});

	/**
	 * Every key the room answers, each on a fresh stage: the guide goes and the
	 * room is exactly as it was. A key that also acted would open, close,
	 * create, move or leave.
	 */
	it("goes on any key, and that key does nothing else", async () => {
		const keys: Record<string, string> = {
			enter: KEY.enter,
			space: " ",
			escape: KEY.escape,
			toggle: KEY.toggle,
			tab: "\t",
			left: KEY.left,
			right: KEY.right,
			home: KEY.home,
			end: KEY.end,
			digit: "2",
			n: "n",
			x: "x",
			r: "r",
			question: "?",
		};
		const outcomes: Record<string, unknown> = {};
		for (const [name, data] of Object.entries(keys)) {
			const driver = await stage();
			await driver.press(data);
			await driver.settle();
			outcomes[name] = {
				guide: text(driver.lastFrame).includes(CLOSES),
				naming: text(driver.lastFrame).includes("Name conversation"),
				// Entering starts with the host asked to put a conversation on screen.
				entering: driver.host.prepares.length + driver.host.lands.length,
				creates: driver.host.creates.length,
				closes: driver.host.closes.length,
				layout: driver.stage.layout,
				selected: pagerSelection(driver.lastFrame, 3),
			};
		}
		const untouched = {
			guide: false,
			naming: false,
			entering: 0,
			creates: 0,
			closes: 0,
			layout: "side-by-side",
			selected: 0,
		};
		expect(outcomes).toEqual(Object.fromEntries(Object.keys(keys).map(name => [name, untouched])));
	});

	it("goes on a click, without choosing the window under it", async () => {
		const driver = await stage();
		const edge = selectedWindowEdge(driver.lastFrame, 1);
		if (!edge) throw new Error("the selected window's top edge is not on the frame");
		await driver.press(sgrMouse(0, edge.x + 2, edge.y + 1));
		await driver.settle();
		expect({
			guide: text(driver.lastFrame).includes(CLOSES),
			entering: driver.host.prepares.length + driver.host.lands.length,
		}).toEqual({ guide: false, entering: 0 });
	});

	it("comes back on ?, typed plainly or through the kitty keyboard protocol", async () => {
		for (const question of ["?", "\x1b[63u"]) {
			const driver = await stage({ showGuide: false });
			expect(text(driver.lastFrame)).not.toContain(CLOSES);
			expect(stripVTControlCharacters(driver.lastFrame.at(-1) ?? "")).toContain("? guide");
			await driver.press(question);
			await driver.settle();
			expect(text(driver.lastFrame)).toContain(CLOSES);
		}
	});

	it("is not offered, and ? does nothing, on a stage given no guide", async () => {
		const driver = await stage({ guide: false, showGuide: true });
		expect(text(driver.lastFrame)).not.toContain(CLOSES);
		expect(stripVTControlCharacters(driver.lastFrame.at(-1) ?? "")).not.toContain("guide");
		await driver.press("?");
		await driver.settle();
		expect(text(driver.lastFrame)).not.toContain(CLOSES);
		expect(stripVTControlCharacters(driver.lastFrame.at(-1) ?? "")).not.toContain("guide");
		// And the next key reaches the room: nothing is waiting to swallow it.
		await driver.press(KEY.right);
		await driver.settle();
		expect(pagerSelection(driver.lastFrame, 3)).toBe(1);
	});

	it("never shows over a quick switch", async () => {
		const driver = new StageDriver({
			width: 120,
			height: 40,
			members: roster(),
			motion: false,
			mode: { kind: "travel", targetId: "m1" },
			guide: guide(),
			showGuide: true,
		});
		for (let frame = 0; frame < 5; frame++) await driver.step();
		expect(driver.frames.some(rows => text(rows).includes(CLOSES))).toBe(false);
	});

	/**
	 * Down to a terminal too small for the card: no row of any frame is wider
	 * than the terminal; wherever there is room for the lead and the closing
	 * line (40 columns by 14 rows) the card is drawn; and a card that is drawn
	 * is drawn whole: its top edge from corner to corner, and its closing line
	 * against its left side.
	 */
	it("is drawn whole wherever it fits, and never past the terminal", async () => {
		const box = theme.boxRound;
		const titled = `${box.topLeft}${box.horizontal} The room `;
		const problems: string[] = [];
		for (const width of [20, 29, 30, 34, 40, 60, 80, 100, 160]) {
			for (const height of [6, 8, 11, 14, 20, 30, 50]) {
				const driver = await stage({ width, height });
				const rows = driver.lastFrame.map(row => stripVTControlCharacters(row));
				driver.lastFrame.forEach((row, y) => {
					const w = visibleWidth(row);
					if (w > width) problems.push(`${width}x${height} row ${y} is ${w} wide`);
				});
				const top = rows.find(row => row.includes(titled));
				if (top === undefined) {
					if (width >= 40 && height >= 14) problems.push(`${width}x${height} has room and drew no card`);
					continue;
				}
				const left = top.indexOf(titled);
				const right = top.indexOf(box.topRight, left);
				const edgeWhole =
					right > left && [...top.slice(left + titled.length, right)].every(glyph => glyph === box.horizontal);
				const closing = rows.find(row => row.includes(CLOSES));
				const closingWhole = closing?.slice(left).startsWith(`${box.vertical} ${CLOSES}`) === true;
				if (!edgeWhole || !closingWhole) problems.push(`${width}x${height} drew the card cut`);
			}
		}
		expect(problems).toEqual([]);
	});
});

describe("/room help", () => {
	it("prints every row of the guide, and how to bring the card back in the room view", () => {
		const markdown = roomGuideMarkdown(guide());
		expect(markdown.startsWith(guide().lead)).toBe(true);
		for (const section of guide().sections) {
			expect(markdown).toContain(`**${section.title}**`);
			for (const row of section.rows) expect(markdown).toContain(`| \`${row.keys}\` | ${row.text} |`);
		}
		expect(markdown).toContain("`?` shows this again");
	});

	it("names the room's keys as they are bound, and leaves out one that is unbound", () => {
		const rebound = roomGuide({ view: "ctrl+g", next: undefined, previous: undefined });
		const keys = rebound.sections.flatMap(section => section.rows.map(row => row.keys));
		expect(keys).toContain("ctrl+g · →→");
		expect(keys.filter(key => key.includes("alt+"))).toEqual([]);
		expect(roomGuide({ view: undefined, next: undefined, previous: undefined }).sections[0]?.rows[0]?.keys).toBe(
			"→→",
		);
		// The marks the guide shows are the glyphs the room paints.
		expect(keys).toContain(`${theme.status.warning} needs you`);
		expect(keys).toContain(`${theme.status.success} ${theme.status.error}`);
	});
});
