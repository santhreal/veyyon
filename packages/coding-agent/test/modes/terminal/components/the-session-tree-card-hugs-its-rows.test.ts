/**
 * WHY. The `/tree` card painted a fixed twenty-plus-row box whatever the session
 * held, so a nine-entry tree sat above eleven blank rows and read as a list that
 * failed to load the rest. Three more defects rode along in the same rows: the
 * active-path bullet existed only on active rows and shoved their text two cells
 * right of their own siblings, so the content column was ragged; nothing
 * distinguished the CURRENT LEAF from the rest of the path, which is the one
 * position a navigator exists to show; and the filter mode was named on a body
 * row at the far end of the card, only while it was NOT `default`, so the one
 * view that hides entries without saying so was the view that said nothing.
 *
 * THE CLASS THIS CLOSES. A row column whose width depends on the row's state
 * (leaf, on-path, off-path), a card height that ignores its content, and a
 * narrowing control whose effect is not named on screen. The filter sweep is
 * driven from the `treeFilterMode` setting's declared values at run time, so a
 * sixth mode added to the setting turns this suite red until it is reachable
 * from `ctrl+O` and named in the header.
 *
 * WHAT IT DOES NOT CATCH. Colour: the rail tints accent on the active path and
 * dim off it, and the assertions here read glyphs and columns, not SGR. It also
 * says nothing about the rail's own shape under `├─`/`└─`, which is pinned by
 * the #2298 and #2325 suites, nor about who mounts the card.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { INTERACTION_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/interaction";
import {
	TREE_FILTER_MODES,
	TreeSelectorComponent,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/tree-selector";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 110;
const ROWS = 40;
/** Fixed wall clock, so an age cell is arithmetic rather than a race with the minute. */
const NOW = Date.parse("2025-03-04T12:00:00.000Z");

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
	setSystemTime(new Date(NOW));
});

afterEach(() => {
	geometry.restore();
	setSystemTime();
});

let counter = 0;

function node(message: AgentMessage, parentId: string | null, agoMs: number, label?: string): SessionTreeNode {
	const id = `e${counter++}`;
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date(NOW - agoMs).toISOString(),
		message,
	};
	return { entry, children: [], label };
}

/** A user entry under `parent` (or a root when null), `agoMs` old. */
function user(text: string, parent: SessionTreeNode | null, agoMs = 0, label?: string): SessionTreeNode {
	const child = node({ role: "user", content: text, timestamp: ++counter }, parent?.entry.id ?? null, agoMs, label);
	parent?.children.push(child);
	return child;
}

function assistant(text: string, parent: SessionTreeNode, agoMs = 0): SessionTreeNode {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: ++counter,
	} as AgentMessage;
	const child = node(message, parent.entry.id, agoMs);
	parent.children.push(child);
	return child;
}

function card(
	tree: SessionTreeNode[],
	leafId: string,
	width = WIDTH,
	filter?: (typeof TREE_FILTER_MODES)[number],
): string[] {
	const component = new TreeSelectorComponent(
		tree,
		leafId,
		() => {},
		() => {},
		undefined,
		filter,
	);
	return component.render(width).map(line => Bun.stripANSI(line));
}

interface Card {
	/** Body-and-chrome rows of the card, border columns trimmed off each one. */
	rows: string[];
	/** Frame rows the card occupies, borders included. */
	height: number;
	/** Rows carrying nothing: the card's vertical padding, and any filler. */
	blank: number;
}

/**
 * The card out of a full-screen frame: one string per card row with the border
 * and pad columns removed, so an assertion about a row's columns is about the
 * list rather than about where the card sits on screen.
 */
function cardOf(frame: readonly string[]): Card {
	const box = theme.boxSharp;
	const top = frame.findIndex(line => line.includes(box.topLeft));
	const topLine = frame[top];
	if (topLine === undefined) throw new Error("cardOf: the frame carries no card");
	const left = topLine.indexOf(box.topLeft);
	const right = topLine.lastIndexOf(box.topRight);
	const bottom = frame.findIndex((line, row) => row > top && line[left] === box.bottomLeft);
	if (bottom === -1) throw new Error("cardOf: the card has no bottom border");
	const rows = frame.slice(top + 1, bottom).map(line => line.slice(left + 2, right - 1).trimEnd());
	return {
		rows,
		height: bottom - top + 1,
		blank: rows.filter(line => line.replace(box.vertical, "").trim() === "").length,
	};
}

/** The row carrying `needle`, border columns already trimmed. */
function rowOf(frame: readonly string[], needle: string): string {
	const row = cardOf(frame).rows.find(line => line.includes(needle));
	if (row === undefined) throw new Error(`no row carries ${JSON.stringify(needle)}`);
	return row;
}

/** The card's header row: search on the left, counts and filter mode on the right. */
function headerOf(frame: readonly string[]): string {
	const header = cardOf(frame).rows[0];
	if (header === undefined) throw new Error("headerOf: the card has no header row");
	return header;
}

/** A linear chain of `count` user entries, newest last. */
function chainOf(count: number): { roots: SessionTreeNode[]; leafId: string } {
	const root = user("prompt 0", null, count * 60_000);
	let tail = root;
	for (let i = 1; i < count; i++) tail = user(`prompt ${i}`, tail, (count - i) * 60_000);
	return { roots: [root], leafId: tail.entry.id };
}

/**
 * Card rows that are not body: two borders, the header row, two dividers and the
 * two-row footer chip band.
 */
const CHROME_ROWS = 7;

describe("the session tree card hugs its rows", () => {
	it("grows one row per entry instead of painting a fixed box", () => {
		counter = 0;
		const small = chainOf(3);
		const shortCard = cardOf(card(small.roots, small.leafId));
		counter = 0;
		const big = chainOf(9);
		const tallCard = cardOf(card(big.roots, big.leafId));

		expect(tallCard.height - shortCard.height).toBe(6);
		expect(tallCard.height).toBeLessThan(ROWS);
	});

	it("never grows past the terminal, and pads no further than the card's own margin", () => {
		counter = 0;
		const small = chainOf(3);
		const shortCard = cardOf(card(small.roots, small.leafId));
		counter = 0;
		const long = chainOf(200);
		const tallCard = cardOf(card(long.roots, long.leafId));

		expect(tallCard.height).toBeLessThanOrEqual(ROWS);
		// Blank rows inside the card are its vertical padding and nothing else. A
		// card sized past its content pads the difference with filler, so the short
		// tree would carry more blank rows than the tree that fills the terminal.
		expect(shortCard.blank).toBe(tallCard.blank);
		// And the tall card spends every remaining row on an entry.
		const shown = tallCard.rows.filter(line => line.includes("prompt")).length;
		expect(shown).toBe(tallCard.height - tallCard.blank - CHROME_ROWS);
	});

	it("keeps entry text in one column whether the row is on the active path or off it", () => {
		counter = 0;
		const root = user("open the session", null, 60 * 60_000);
		const reply = assistant("reading the tree", root, 59 * 60_000);
		const live = user("branch alpha stays live", reply, 30 * 60_000);
		user("branch bravo was abandoned", reply, 58 * 60_000);
		const leaf = assistant("alpha is the current branch", live, 2 * 60_000);

		const frame = card([root], leaf.entry.id);
		const onPath = rowOf(frame, "branch alpha stays live");
		const offPath = rowOf(frame, "branch bravo was abandoned");

		expect(onPath.indexOf("user:")).toBe(offPath.indexOf("user:"));
		// The mark column is what differs: the on-path row spends it, the off-path
		// row leaves it blank.
		expect(onPath).toContain(`${theme.md.bullet} user:`);
		expect(offPath).not.toContain(theme.md.bullet);
	});

	it("marks the current leaf apart from the rest of the active path", () => {
		counter = 0;
		const root = user("open the session", null, 60 * 60_000);
		const reply = assistant("reading the tree", root, 59 * 60_000);
		const live = user("branch alpha stays live", reply, 30 * 60_000);
		user("branch bravo was abandoned", reply, 58 * 60_000);
		const leaf = assistant("alpha is the current branch", live, 2 * 60_000);

		const frame = card([root], leaf.entry.id);
		const pathRows = ["open the session", "reading the tree", "branch alpha stays live"].map(text =>
			rowOf(frame, text),
		);
		const leafRow = rowOf(frame, "alpha is the current branch");
		const abandoned = rowOf(frame, "branch bravo was abandoned");

		// One leaf glyph in the card, on the leaf row.
		expect(leafRow).toContain(`${theme.status.active} assistant:`);
		expect(cardOf(frame).rows.filter(line => line.includes(theme.status.active))).toHaveLength(1);
		// The rest of the path carries the plain bullet, never the leaf glyph.
		for (const row of pathRows) {
			expect(row).toContain(theme.md.bullet);
			expect(row).not.toContain(theme.status.active);
		}
		// Off the path, neither.
		expect(abandoned).not.toContain(theme.md.bullet);
		expect(abandoned).not.toContain(theme.status.active);
	});
});

describe("the session tree header names what narrowed the tree", () => {
	it("steps ctrl+O through exactly the modes the setting declares", () => {
		expect([...TREE_FILTER_MODES]).toEqual([...INTERACTION_SETTINGS.treeFilterMode.values]);
	});

	it("names the mode and the visible-of-total count in every declared mode", () => {
		const first = "alpha prompt";
		const second = "bravo prompt";
		const third = "charlie prompt";
		const reply = "a reply with text";
		for (const mode of INTERACTION_SETTINGS.treeFilterMode.values) {
			counter = 0;
			const root = user(first, null, 10 * 60_000, "landmark");
			const answer = assistant(reply, root, 9 * 60_000);
			const middle = user(second, answer, 8 * 60_000);
			const leaf = user(third, middle, 7 * 60_000);

			const frame = card([root], leaf.entry.id, WIDTH, mode);
			const header = headerOf(frame);

			expect(header).toContain(mode);
			const counts = /(?<visible>\d+)\/(?<total>\d+)/.exec(header)?.groups;
			if (counts === undefined) throw new Error(`header names no counts in ${mode}: ${header}`);
			expect(Number(counts.total)).toBe(4);

			// The count is the rows on screen, not a number kept beside them.
			const rows = cardOf(frame).rows;
			const shown = [first, second, third, reply].filter(text => rows.some(line => line.includes(text))).length;
			expect(Number(counts.visible)).toBe(shown);
		}
	});
});

describe("the session tree row dates itself", () => {
	it("ages each row, and says nothing for an entry seconds old", () => {
		counter = 0;
		const root = user("three hours back", null, 3 * 60 * 60_000);
		const recent = assistant("written seconds ago", root, 20_000);
		const old = user("five days back", recent, 5 * 24 * 60 * 60_000);

		const frame = card([root], old.entry.id);

		expect(rowOf(frame, "three hours back").endsWith("3h")).toBe(true);
		expect(rowOf(frame, "five days back").endsWith("5d")).toBe(true);
		expect(rowOf(frame, "written seconds ago").endsWith("written seconds ago")).toBe(true);
	});

	it("truncates the entry text rather than letting it run under the age", () => {
		counter = 0;
		const root = user(`overlong prompt ${"x".repeat(400)}`, null, 4 * 60 * 60_000);
		const leaf = assistant("short reply", root, 2 * 60 * 60_000);

		const row = rowOf(card([root], leaf.entry.id), "overlong prompt");

		expect(row.endsWith("4h")).toBe(true);
		expect(row).toContain("…");
		expect(row.length).toBeLessThanOrEqual(WIDTH);
	});

	it("spends the age cells on entry text when the card is narrow", () => {
		counter = 0;
		const root = user("three hours back", null, 3 * 60 * 60_000);
		const leaf = assistant("a reply", root, 2 * 60 * 60_000);

		const frame = card([root], leaf.entry.id, 46);

		expect(rowOf(frame, "three hours back").endsWith("3h")).toBe(false);
		expect(frame.some(line => /\s3h\s*$/.test(line))).toBe(false);
	});
});
