/**
 * What a tool block's frame is measured against.
 *
 * THE DEFECT. `renderOutputBlock` drew every frame at the terminal width and padded
 * every row out to it. A tool block is the most repeated object in a session — every
 * read, bash, grep, edit and task result is one — so the screen was a stack of
 * full-bleed rectangles whose right wall was always in the same column no matter what
 * was in them: a two-word result claimed the same rectangle as a hundred-line diff.
 * `Box.setHugContent` had already carried the reason since 2026-07-22 ("the same frame
 * stretched to the terminal edge reads as a wall"), and two other components had been
 * fixed for it; the one that draws most of the screen had not.
 *
 * THE CLASS. Any block-drawing owner that takes its width from the terminal rather
 * than from its own ink. That is why these tests are written against
 * `renderOutputBlock` — the single choke point every framed tool result passes
 * through — with the arithmetic asserted rather than a pinned rectangle, plus real
 * `ToolExecutionComponent` arms so the wiring is proven and not just the helper.
 *
 * WHAT THIS DOES NOT CATCH. A renderer that hand-rolls its own frame instead of going
 * through the owner. There is exactly one, `tools/bash-interactive.ts`, and it is
 * deliberate: that block mirrors a live PTY, whose width IS the terminal's, so a
 * hugged frame would misreport the geometry the program inside it is drawing to. A
 * second hand-rolled frame added elsewhere would be a second definition of what a
 * block looks like, and nothing here would see it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	type OutputBlockOptions,
	outputBlockContentWidth,
	renderOutputBlock,
} from "@veyyon/coding-agent/tui/output-block";
import { type TUI, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

const SRC = path.join(import.meta.dirname, "..", "src");

/** Rows with every escape sequence removed, so widths are ink and not bytes. */
function plain(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line));
}

/**
 * The states a block can be in, read out of the declaration at run time. A state
 * added to `State` and not to this sweep would otherwise be the one member whose
 * background nobody checked.
 */
async function declaredStates(): Promise<string[]> {
	const text = await fs.readFile(path.join(SRC, "tui", "types.ts"), "utf8");
	const declaration = /export type State\s*=([^;]+);/.exec(text);
	if (!declaration) throw new Error("State is no longer an exported type alias in src/tui/types.ts");
	const members = [...declaration[1].matchAll(/"([^"]+)"/g)].map(m => m[1]!);
	if (members.length === 0) throw new Error("State declares no string members");
	return members;
}

/** The shapes a block is built in, so no arm of the layout escapes the measurement. */
const SHAPES: ReadonlyArray<{ name: string; build: (width: number) => OutputBlockOptions }> = [
	{
		name: "a header and one short line",
		build: width => ({ width, header: "Read src/parser.ts", sections: [{ lines: ["export function parse() {}"] }] }),
	},
	{
		name: "a header with meta",
		build: width => ({ width, header: "Read", headerMeta: "src/parser.ts", sections: [{ lines: ["ok"] }] }),
	},
	{
		name: "no header at all",
		build: width => ({ width, sections: [{ lines: ["$ npm run migrate:up"] }] }),
	},
	{
		name: "a labelled section",
		build: width => ({
			width,
			header: "bash",
			sections: [{ lines: ["$ ls"] }, { label: "Output", lines: ["a.ts", "b.ts"] }],
		}),
	},
	{
		name: "a plain separator between sections",
		build: width => ({
			width,
			header: "bash",
			sections: [{ lines: ["$ ls"] }, { separator: true, lines: ["a.ts"] }],
		}),
	},
	{
		name: "a header longer than its body",
		build: width => ({
			width,
			header: "Read a/very/long/path/that/is/wider/than/the/body.ts",
			sections: [{ lines: ["x"] }],
		}),
	},
	{
		name: "no content at all",
		build: width => ({ width, header: "Read src/parser.ts" }),
	},
	{
		name: "two columns of left padding",
		build: width => ({ width, header: "Read", contentPaddingLeft: 2, sections: [{ lines: ["ok"] }] }),
	},
	{
		name: "no left padding",
		build: width => ({ width, header: "Read", contentPaddingLeft: 0, sections: [{ lines: ["ok"] }] }),
	},
];

/** The one glyph that says a block drew a frame, in the theme's own alphabet. */
function frameGlyph(): string {
	return theme.boxSharp.topLeft;
}

describe("a tool block is as wide as its output, not as wide as the screen", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it.each(SHAPES.map(shape => [shape.name, shape] as const))("%s draws one rectangle", (_name, shape) => {
		const lines = plain(renderOutputBlock(shape.build(120), theme));
		const widths = new Set(lines.map(visibleWidth));
		expect(widths.size).toBe(1);
	});

	it.each(SHAPES.map(shape => [shape.name, shape] as const))("%s stops well short of the terminal", (_name, shape) => {
		const lines = plain(renderOutputBlock(shape.build(120), theme));
		// Not merely "at most the terminal": a wall also satisfies that. The block has
		// to be narrower than the screen it is standing on, by the margin its own text
		// leaves, and the widest shape here is nowhere near 120 columns.
		expect(visibleWidth(lines[0]!)).toBeLessThan(100);
		expect(lines[0]!).toStartWith(frameGlyph());
	});

	it("takes its width from its widest row, plus its own chrome and one column of air", () => {
		const body = ["a", "a much longer line than the first one", "mid"];
		const lines = plain(renderOutputBlock({ width: 200, header: "T", sections: [{ lines: body }] }, theme));
		const widestInk = Math.max(...body.map(visibleWidth));
		// Two walls, one column of left padding, one column of air before the right wall.
		expect(visibleWidth(lines[0]!)).toBe(widestInk + 4);
	});

	it("keeps a header longer than its body whole, with a rule after it", () => {
		const header = "Read a/very/long/path/that/is/wider/than/the/body.ts";
		const lines = plain(renderOutputBlock({ width: 200, header, sections: [{ lines: ["x"] }] }, theme));
		// The label is the widest thing in the block, so the block is built around it: the
		// whole path is on screen and the rule still runs to the corner. A block sized off
		// its body alone truncates the one row that says which file this is.
		expect(lines[0]!).toContain(header);
		const tail = theme.boxSharp.horizontal.repeat(3) + theme.boxSharp.topRight;
		expect(lines[0]!).toEndWith(tail);
	});

	it("grows with its content rather than staying pinned to the frame", () => {
		const short = "!".repeat(20);
		const long = "!".repeat(60);
		const narrow = plain(renderOutputBlock({ width: 200, header: "T", sections: [{ lines: [short] }] }, theme));
		const wide = plain(renderOutputBlock({ width: 200, header: "T", sections: [{ lines: [long] }] }, theme));
		// Both blocks are content-dominated, so the whole difference between them is the
		// difference between their bodies. A frame taken from the terminal would report 0.
		expect(visibleWidth(wide[0]!) - visibleWidth(narrow[0]!)).toBe(40);
	});

	it("never reaches past the terminal, even when a line fills every column it was wrapped to", () => {
		const width = 40;
		const line = "x".repeat(outputBlockContentWidth(width));
		const lines = plain(renderOutputBlock({ width, header: "T", sections: [{ lines: [line] }] }, theme));
		for (const row of lines) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		// And it really did use the room: the air is what gets dropped at the edge, not
		// a column of the content.
		expect(visibleWidth(lines[0]!)).toBe(width);
	});

	it("wraps its body at the width a renderer budgets rows against, not at the hugged width", () => {
		const width = 40;
		const contentWidth = outputBlockContentWidth(width);
		const sentence = "one two three four five six seven eight nine ten eleven twelve thirteen".repeat(2);
		const lines = renderOutputBlock({ width, header: "T", sections: [{ lines: [sentence] }] }, theme);
		// Header bar, the wrapped rows, bottom bar. A hug that changed the wrap width
		// would change this count, and every renderer that sizes a tail window against
		// `outputBlockContentWidth` would overflow its intended height.
		expect(lines.length).toBe(wrapTextWithAnsi(sentence, contentWidth).length + 2);
	});

	it("paints a state background over the block and nowhere else", async () => {
		for (const state of await declaredStates()) {
			const options: OutputBlockOptions = {
				width: 120,
				header: "Read src/parser.ts",
				state: state as OutputBlockOptions["state"],
				sections: [{ lines: ["export function parse() {}"] }],
			};
			const painted = renderOutputBlock(options, theme);
			const widths = new Set(plain(painted).map(visibleWidth));
			expect(widths.size, state).toBe(1);
			// The fill is the block's own rectangle: a background padded to the terminal
			// is the slab this class of defect always turns into.
			expect([...widths][0]!, state).toBeLessThan(100);
		}
	});

	it("is the same rectangle whether or not it is painted", async () => {
		for (const state of await declaredStates()) {
			const base: OutputBlockOptions = {
				width: 120,
				header: "Read src/parser.ts",
				state: state as OutputBlockOptions["state"],
				sections: [{ lines: ["export function parse() {}"] }],
			};
			const painted = plain(renderOutputBlock({ ...base, applyBg: true }, theme));
			const bare = plain(renderOutputBlock({ ...base, applyBg: false }, theme));
			expect(painted.map(visibleWidth), state).toEqual(bare.map(visibleWidth));
		}
	});

	it("hugs a real bash block through the component that owns it", () => {
		const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		block.setArgsComplete();
		block.updateResult({
			content: [{ type: "text", text: "migrated 3 tables" }],
			details: { exitCode: 0 },
			isError: false,
		} as never);
		const framed = plain(block.render(120)).filter(line => line.includes(frameGlyph()) || line.includes("│"));
		expect(framed.length).toBeGreaterThan(0);
		for (const row of framed) expect(visibleWidth(row.replace(/\s+$/, ""))).toBeLessThan(60);
	});

	it("hugs a real read block through the component that owns it", () => {
		const block = createToolExecution("read", { path: "src/parser.ts" }, {}, undefined, ui);
		block.setArgsComplete();
		block.updateResult({
			content: [{ type: "text", text: "export function parse() {}" }],
			isError: false,
		} as never);
		const framed = plain(block.render(120)).filter(line => line.includes(frameGlyph()) || line.includes("│"));
		expect(framed.length).toBeGreaterThan(0);
		for (const row of framed) expect(visibleWidth(row.replace(/\s+$/, ""))).toBeLessThan(60);
	});
});
