/**
 * WHY THIS SUITE EXISTS.
 *
 * The room view is a fullscreen overlay whose every frame is composited from
 * windows that move, overlap and hang off the screen edges while a gesture
 * plays. A frame that is not exactly the terminal is a torn screen: a row one
 * cell too wide is cut by the engine and loses a window's right edge, a
 * covered row one cell short shifts every window after the short piece, a row
 * count other than the terminal's slides the chrome, and a row that ends with
 * a colour or weight still open paints it into whatever the terminal draws
 * next. A piece of one window cut on the second half of a wide glyph used to
 * draw the rest of that window one cell to the left.
 *
 * THE CLASS, NOT THE INCIDENT.
 *
 * - Every frame of every gesture (the open from the screen, a glide along the
 *   row, a layout flip, a glide back, an enter, the quick switch), at every
 *   size in a sweep from 20x10 to 260x60, in both layouts, for one to seven
 *   conversations plus the new-conversation slot, is checked twice: the stage's
 *   own rows (row count, no row wider than the terminal, every row either the
 *   terminal's width or bare ground outside the chrome rows, every row closed)
 *   and the frame the engine paints for a fullscreen overlay (every row exactly
 *   the terminal's width). At rest, the rows a window covers are exactly the
 *   terminal's width, read against the geometry the stage lays out from.
 * - The compositor is checked cell by cell on generated layers that overlap,
 *   hang off both edges, cut wide glyphs on both sides and leave styles open:
 *   every cell is its topmost window's cell at its own column in its own style,
 *   or unstyled ground.
 * - The two painters are swept at every width 0..160 and height 0..40, over
 *   every window state (a `Record` keyed by the state union, so a new state
 *   fails the type check until it is given a sample) with and without a
 *   waiting dialog and with and without a draft of wide glyphs and
 *   attachments: a window with area is exactly `height` rows of exactly
 *   `width` cells, closed; a window with no area is no rows.
 *
 * WHAT IT DOES NOT CATCH.
 *
 * Whether the cells are the right cells (the entering and key suites read
 * those). A terminal whose width table disagrees with `visibleWidth` on an
 * ambiguous-width glyph. The 256-colour build of the theme: the sweep runs on
 * the truecolor build, which carries every fade path; the 256-colour build
 * writes the same row shapes with quantized colours.
 */

import { describe, expect, it } from "bun:test";
import {
	placeRoomWindows,
	ROOM_CHROME_BOTTOM_ROWS,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-geometry";
import { compositeRoomLayers, type RoomLayout } from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import type {
	RoomDraft,
	RoomFeedBlock,
	RoomWindowSnapshot,
	RoomWindowState,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { paintRoomNewSlot, paintRoomWindow } from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { lcg } from "@veyyon/utils/adversarial-strings";
import { visibleWidth } from "@veyyon/utils/width";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { type Cell, cellText, openStyleAtEnd, paintedFrame, rowCells } from "./room-frame-oracle";
import { FakeMember, FRAME_MS, KEY, START_MS, StageDriver, screenRows, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const WIDTHS = [20, 37, 60, 100, 150, 213, 260] as const;
const HEIGHTS = [10, 18, 28, 40, 60] as const;
const LAYOUTS: readonly RoomLayout[] = ["side-by-side", "all-windows"];
const MAX_MEMBERS = 7;
/**
 * The sweep samples every other 60Hz frame, as a terminal that drops frames under load paints
 * them: the frames still straddle every gesture's curve from end to end, at half the cost.
 */
const SWEEP_FRAME_MS = 2 * FRAME_MS;

/** One sample of every state a window can be in. A new state is a type error here until it has one. */
const STATES: Record<RoomWindowState["kind"], RoomWindowState> = {
	new: { kind: "new" },
	working: { kind: "working", since: START_MS - 65_000, activity: "tool" },
	done: { kind: "done", at: START_MS - 1_000 },
	failed: { kind: "failed", reason: "exit 1" },
	stopped: { kind: "stopped" },
};
const STATE_KINDS = Object.keys(STATES) as Array<RoomWindowState["kind"]>;

/** One sample of every feed block, the prompt first as a feed has it. A new kind is a type error until it has one. */
const BLOCKS: Record<RoomFeedBlock["kind"], readonly RoomFeedBlock[]> = {
	prompt: [
		{
			kind: "prompt",
			text: "refactor the 認証 layer so every handler reads the session once\nand keep the old 🙂 behaviour behind a flag while the migration runs",
		},
	],
	tool: [
		{ kind: "tool", label: "Read", detail: "src/auth/session.ts", state: "ok" },
		{ kind: "tool", label: "Edit", detail: "src/auth/漢字-handler.ts", state: "running" },
		{ kind: "tool", label: "Bash", detail: "bun test", state: "error" },
	],
	text: [
		{
			kind: "text",
			text: "## Plan\n\nThe **session** is read in `three` places; 認証 moves to one reader and the 🙂 flag gates the old path.\n\n```ts\nconst x = 1;\n```",
		},
	],
	thinking: [{ kind: "thinking" }],
	note: [
		{ kind: "note", text: "Compacted the conversation: 42 messages folded", tone: "muted" },
		{ kind: "note", text: "The provider refused: rate limited", tone: "error" },
	],
};
const FEED: readonly RoomFeedBlock[] = [
	...BLOCKS.prompt,
	...(Object.keys(BLOCKS) as Array<RoomFeedBlock["kind"]>)
		.filter(kind => kind !== "prompt")
		.flatMap(kind => BLOCKS[kind]),
];

const NAMES: ReadonlyArray<{ title?: string }> = [
	{ title: "refactor 認証 flow for the whole service layer and its tests" },
	{ title: "a" },
	{},
];

/** A draft whose line is wide glyphs and whose attachments take the rest of the row. */
const DRAFT: RoomDraft = { line: "認証の流れを直して、テストも全部書き直す", images: 2, files: 1 };

function roster(count: number): FakeMember[] {
	return Array.from(
		{ length: count },
		(_, i) =>
			new FakeMember(
				`m${i}`,
				snapshotOf(
					STATES[STATE_KINDS[(i + 1) % STATE_KINDS.length]!],
					i % 3 === 2 ? [] : FEED,
					NAMES[i % NAMES.length],
				),
				{ origin: i === 0, waitingDialogs: i === 2 ? 1 : 0, draft: i % 3 === 1 ? DRAFT : undefined },
			),
	);
}

/** Rows the chrome writes when no window covers them: the title, the pager, the key hints. */
function chromeRows(height: number): ReadonlySet<number> {
	return new Set([0, height - ROOM_CHROME_BOTTOM_ROWS + 1, height - 1]);
}

/** Everything wrong with one frame, empty when it is exactly the terminal. */
function frameProblems(rows: readonly string[], width: number, height: number): string[] {
	const problems: string[] = [];
	const chrome = chromeRows(height);
	if (rows.length !== height) problems.push(`${rows.length} rows for a ${height}-row terminal`);
	for (let y = 0; y < rows.length; y++) {
		const row = rows[y]!;
		const w = visibleWidth(row);
		if (w > width) problems.push(`row ${y} is ${w} cells wide`);
		else if (!chrome.has(y) && row !== "" && w !== width)
			problems.push(`row ${y} is ${w} cells, neither the terminal's width nor bare ground`);
		const open = openStyleAtEnd(row);
		if (open !== "") problems.push(`row ${y} ends with ${open} open`);
	}
	const painted = paintedFrame(rows, width, height);
	if (painted.length !== height) problems.push(`the engine paints ${painted.length} rows`);
	for (let y = 0; y < painted.length; y++) {
		const w = visibleWidth(painted[y]!);
		if (w !== width) problems.push(`painted row ${y} is ${w} cells`);
	}
	return problems;
}

/** At rest the layout is known: the rows a window covers are exactly the terminal's width. */
function restProblems(
	rows: readonly string[],
	viewport: { width: number; height: number },
	state: { count: number; selected: number; mix: number },
): string[] {
	const placements = placeRoomWindows(viewport, {
		count: state.count,
		scroll: state.selected,
		selected: state.selected,
		zoom: 0,
		mix: state.mix,
	});
	const covered = new Set<number>();
	for (const { rect } of placements) {
		if (rect.x >= viewport.width || rect.x + rect.w <= 0) continue;
		for (let y = Math.max(0, rect.y); y < Math.min(viewport.height, rect.y + rect.h); y++) covered.add(y);
	}
	const problems: string[] = [];
	if (covered.size === 0) problems.push("no window covers any row at rest");
	for (let y = 0; y < rows.length; y++) {
		const w = visibleWidth(rows[y]!);
		if (covered.has(y) && w !== viewport.width) problems.push(`covered row ${y} is ${w} cells at rest`);
	}
	if (!cellText(rowCells(rows[0] ?? "")).includes("Room")) problems.push("the title row is not drawn at rest");
	return problems;
}

async function sweepSize(width: number, height: number, layout: RoomLayout): Promise<void> {
	const problems: string[] = [];
	const note = (where: string, found: readonly string[]): void => {
		for (const problem of found)
			if (problems.length < 12) problems.push(`${width}x${height} ${layout} ${where}: ${problem}`);
	};
	const mix = layout === "all-windows" ? 1 : 0;
	for (let count = 1; count <= MAX_MEMBERS; count++) {
		const driver = new StageDriver({
			width,
			height,
			members: roster(count),
			originScreen: screenRows(width, height, "origin"),
			layout,
		});
		const viewport = { width, height };
		const slots = count + 1;

		driver.render();
		await driver.settle(600, SWEEP_FRAME_MS);
		note(`${count} open at rest`, restProblems(driver.lastFrame, viewport, { count: slots, selected: 0, mix }));

		await driver.press(KEY.end);
		await driver.settle(600, SWEEP_FRAME_MS);
		note(`${count} after End`, restProblems(driver.lastFrame, viewport, { count: slots, selected: count, mix }));

		await driver.press(KEY.tab);
		await driver.settle(600, SWEEP_FRAME_MS);
		note(
			`${count} after Tab`,
			restProblems(driver.lastFrame, viewport, { count: slots, selected: count, mix: 1 - mix }),
		);

		await driver.press(KEY.home);
		await driver.settle(600, SWEEP_FRAME_MS);
		note(
			`${count} after Home`,
			restProblems(driver.lastFrame, viewport, { count: slots, selected: 0, mix: 1 - mix }),
		);

		await driver.press(KEY.enter);
		driver.host.prepares[0]?.resolve(screenRows(width, height, "m0"));
		await driver.settle(600, SWEEP_FRAME_MS);
		if (driver.host.lands.length !== 1) note(`${count} enter`, [`landed ${driver.host.lands.length} times`]);

		driver.frames.forEach((frame, index) => {
			note(`${count} members, frame ${index}`, frameProblems(frame, width, height));
		});

		if (layout === "side-by-side" && count >= 2) {
			const travel = new StageDriver({
				width,
				height,
				members: roster(count),
				originScreen: screenRows(width, height, "origin"),
				layout,
				mode: { kind: "travel", targetId: "m1" },
			});
			travel.render();
			travel.host.prepares[0]?.resolve(screenRows(width, height, "m1"));
			await travel.settle(600, SWEEP_FRAME_MS);
			if (travel.host.lands.length !== 1) note(`${count} travel`, [`landed ${travel.host.lands.length} times`]);
			travel.frames.forEach((frame, index) => {
				note(`${count} members travelling, frame ${index}`, frameProblems(frame, width, height));
			});
		}
	}
	expect(problems).toEqual([]);
}

describe("every frame of the room view is exactly the terminal", () => {
	for (const width of WIDTHS) {
		for (const height of HEIGHTS) {
			for (const layout of LAYOUTS) {
				it(`${width}x${height}, ${layout}: the open, a glide, a flip, a glide back, an enter and the quick switch`, async () => {
					await sweepSize(width, height, layout);
				}, 60_000);
			}
		}
	}
});

// ---------------------------------------------------------------------------------------------
// The compositor, cell by cell.

interface GeneratedLayer {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly rows: readonly string[];
}

const PIECES = [
	"ab",
	"漢",
	"字x",
	"🙂",
	"\x1b[38;2;200;40;40m",
	"\x1b[1m",
	"\x1b[3m",
	"\x1b[48;5;23m",
	"\x1b[39m",
	"\x1b[22m",
	"\x1b[0m",
	"│",
	" ",
	"かな",
];

function generatedRow(next: () => number, cells: number): string {
	let row = "";
	let used = 0;
	while (used < cells) {
		const piece = PIECES[Math.floor(next() * PIECES.length)]!;
		row += piece;
		used += visibleWidth(piece);
	}
	// Half the rows end with whatever they opened still open, as a cut window row does.
	return next() < 0.5 ? row : `${row}\x1b[0m`;
}

function generatedLayers(next: () => number, width: number, height: number): GeneratedLayer[] {
	const count = 1 + Math.floor(next() * 4);
	return Array.from({ length: count }, () => {
		const layerWidth = 1 + Math.floor(next() * (width + 4));
		const rows = 1 + Math.floor(next() * height);
		return {
			x: Math.floor(next() * (width + 8)) - 6,
			y: Math.floor(next() * (height + 2)) - 2,
			width: layerWidth,
			rows: Array.from({ length: rows }, () => generatedRow(next, Math.floor(next() * (layerWidth + 3)))),
		};
	});
}

/** A cell the compositor may draw as any style: the blank left where a wide glyph is cut. */
const CUT = "<cut>";

/** The row the compositor must produce, or undefined when no layer covers it. */
function expectedCells(layers: readonly GeneratedLayer[], width: number, y: number): Cell[] | undefined {
	const owner = new Array<number>(width).fill(-1);
	layers.forEach((layer, index) => {
		if (y < layer.y || y >= layer.y + layer.rows.length) return;
		for (let c = Math.max(0, layer.x); c < Math.min(width, layer.x + layer.width); c++) owner[c] = index;
	});
	if (owner.every(who => who < 0)) return undefined;
	const out: Cell[] = [];
	for (let c = 0; c < width; c++) {
		const who = owner[c]!;
		if (who < 0) {
			out.push({ text: " ", style: "" });
			continue;
		}
		let spanStart = c;
		while (spanStart > 0 && owner[spanStart - 1] === who) spanStart--;
		let spanEnd = c + 1;
		while (spanEnd < width && owner[spanEnd] === who) spanEnd++;
		const layer = layers[who]!;
		const cells = rowCells(layer.rows[y - layer.y] ?? "");
		const at = c - layer.x;
		let lead = at;
		while (lead > 0 && cells[lead]?.text === "") lead--;
		const glyph = cells[lead];
		if (glyph === undefined) {
			out.push({ text: " ", style: "" });
			continue;
		}
		let glyphEnd = lead + 1;
		while (cells[glyphEnd]?.text === "") glyphEnd++;
		const inside = lead + layer.x >= spanStart && glyphEnd + layer.x <= spanEnd;
		out.push(inside ? cells[at]! : { text: " ", style: CUT });
	}
	return out;
}

describe("the compositor puts every window cell at its own column in its own style", () => {
	it("over generated layers that overlap, hang off both edges, cut wide glyphs and leave styles open", () => {
		const problems: string[] = [];
		const next = lcg(0x5eed);
		for (let sample = 0; sample < 1500 && problems.length < 10; sample++) {
			const width = 1 + Math.floor(next() * 40);
			const height = 1 + Math.floor(next() * 6);
			const layers = generatedLayers(next, width, height);
			const { rows, covered } = compositeRoomLayers(layers, width, height);
			const where = `sample ${sample} ${JSON.stringify(layers)}`;
			if (rows.length !== height) problems.push(`${where}: ${rows.length} rows`);
			for (let y = 0; y < height; y++) {
				const row = rows[y] ?? "";
				const expected = expectedCells(layers, width, y);
				if (covered[y] !== (expected !== undefined)) problems.push(`${where}: row ${y} covered=${covered[y]}`);
				if (expected === undefined) {
					if (row !== "") problems.push(`${where}: bare row ${y} is ${JSON.stringify(row)}`);
					continue;
				}
				if (openStyleAtEnd(row) !== "") problems.push(`${where}: row ${y} ends open`);
				const actual = rowCells(row);
				if (actual.length !== width) {
					problems.push(`${where}: row ${y} is ${actual.length} cells`);
					continue;
				}
				for (let c = 0; c < width; c++) {
					const want = expected[c]!;
					const got = actual[c]!;
					const same = want.style === CUT ? got.text === " " : got.text === want.text && got.style === want.style;
					if (!same) {
						problems.push(
							`${where}: row ${y} col ${c} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
						);
						break;
					}
				}
			}
		}
		expect(problems).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// The painters, at every size.

/** Wall time the painters are asked to draw at: a working window's clock reads 1:05. */
const PAINT_NOW = START_MS;
const STRENGTHS = [1, 0.8, 0.62, 0.34, 0.05] as const;

function windowSnapshot(kind: RoomWindowState["kind"], index: number): RoomWindowSnapshot {
	return snapshotOf(STATES[kind], index % 4 === 3 ? [] : FEED, NAMES[index % NAMES.length]);
}

function paintProblems(rows: readonly string[], width: number, height: number): string | undefined {
	if (width <= 0 || height <= 0) return rows.length === 0 ? undefined : `${rows.length} rows for no area`;
	if (rows.length !== height) return `${rows.length} rows`;
	for (let y = 0; y < height; y++) {
		const row = rows[y]!;
		const w = visibleWidth(row);
		if (w !== width) return `row ${y} is ${w} cells`;
		const open = openStyleAtEnd(row);
		if (open !== "") return `row ${y} ends with ${open} open`;
	}
	return undefined;
}

describe("a window is exactly the size it is painted at", () => {
	for (const kind of STATE_KINDS) {
		for (const [waitingDialogs, draft] of [
			[0, undefined],
			[1, undefined],
			[0, DRAFT],
			[1, DRAFT],
		] as const) {
			it(`${kind}, ${waitingDialogs} waiting dialog${waitingDialogs === 1 ? "" : "s"}, ${draft ? "a draft" : "no draft"}, at every width 0..160 and height 0..40`, () => {
				const problems: string[] = [];
				for (let width = 0; width <= 160; width++) {
					const screen = screenRows(width, 30, "crop");
					for (let height = 0; height <= 40; height++) {
						const index = width * 41 + height;
						// Each size draws one of the ways a window is shown, turned by the size so every
						// way meets every size band: a card, a card dissolving toward the screen, the
						// crop in a frame, and the bare crop that is the whole unframed terminal.
						const way = index % 4;
						const rows = paintRoomWindow({
							width,
							height,
							snapshot: windowSnapshot(kind, index),
							ordinal: 1 + (index % 12),
							strength: STRENGTHS[index % STRENGTHS.length]!,
							selected: index % 2 === 0,
							framed: way !== 3,
							waitingDialogs,
							draft,
							screen: way === 0 ? undefined : { rows: screen, mix: way === 1 ? 0.3 : way === 2 ? 0.7 : 1 },
							now: PAINT_NOW,
						});
						const problem = paintProblems(rows, width, height);
						if (problem && problems.length < 10) problems.push(`${width}x${height} (way ${way}): ${problem}`);
					}
				}
				expect(problems).toEqual([]);
			});
		}
	}

	it("the new-conversation slot, idle and starting, selected and not, at every width 0..160 and height 0..40", () => {
		const problems: string[] = [];
		for (let width = 0; width <= 160; width++) {
			for (let height = 0; height <= 40; height++) {
				for (const starting of [false, true]) {
					for (const selected of [false, true]) {
						const rows = paintRoomNewSlot({
							width,
							height,
							strength: STRENGTHS[(width + height) % STRENGTHS.length]!,
							selected,
							starting,
							now: PAINT_NOW + width * FRAME_MS,
						});
						const problem = paintProblems(rows, width, height);
						if (problem && problems.length < 10)
							problems.push(`${width}x${height} starting=${starting} selected=${selected}: ${problem}`);
					}
				}
			}
		}
		expect(problems).toEqual([]);
	});
});
