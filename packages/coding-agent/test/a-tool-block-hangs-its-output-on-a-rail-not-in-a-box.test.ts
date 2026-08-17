/**
 * What a tool block looks like.
 *
 * THE DEFECT, in two stages. `renderOutputBlock` drew a box — a rule with the title
 * cut into it, a wall down each side, a rule under the last row — at the TERMINAL
 * width, padding every row out to reach it. A tool block is the most repeated object
 * in a session (every read, bash, grep, edit and task result is one), so the screen
 * was a stack of full-bleed rectangles whose right wall never moved. Hugging the box
 * to its own ink fixed the wall and left the box: five glyph kinds and two whole rows
 * of chrome around one line of output, forty times a session.
 *
 * WHAT IT IS NOW. A title line, and a rail: one thin glyph down the left of the
 * output, in the state's colour. Nothing above the title, nothing below the last row,
 * nothing to the right of anything. A result with no body is one line. The chrome
 * that remains is two columns wide, which is exactly what the box's two walls cost, so
 * `outputBlockContentWidth` is unchanged and every renderer that budgets rows against
 * it counts the rows it always counted.
 *
 * THE CLASS. Any block-drawing owner that spends rows or columns on chrome instead of
 * on output, or that takes its width from the terminal rather than its own ink. These
 * are written against `renderOutputBlock` — the single choke point every tool result
 * passes through — asserting the arithmetic and the absence of box glyphs rather than
 * pinning a rectangle, plus real `ToolExecutionComponent` arms so the wiring is proven
 * and not just the helper. The `State` sweep is read from the source declaration at run
 * time, so a sixth state cannot arrive with a rail nobody coloured.
 *
 * WHAT THIS DOES NOT CATCH. A renderer that hand-rolls its own frame instead of going
 * through the owner. There is exactly one, `tools/bash-interactive.ts`, and it is
 * deliberate: that block mirrors a live PTY whose width IS the terminal's, so a hugged
 * or railed frame would misreport the geometry the program inside it draws to. A second
 * hand-rolled frame added elsewhere would be a second definition of what a block looks
 * like, and nothing here would see it.
 *
 * WHAT MOVED IN HERE. This suite replaces the hug suite that preceded it
 * (`a-tool-block-is-as-wide-as-its-output-not-as-wide-as-the-screen.test.ts`), which
 * measured the box: its corner glyph, its right wall, and the two chrome rows it spent.
 * Those assertions describe a shape the product no longer draws, so keeping them would
 * have meant one of the two suites had to be wrong. The three contracts of that suite
 * that outlive the box are asserted below rather than deleted with it: the block's width
 * follows its own ink and grows with it, the width is the widest row plus the rail, and
 * a plate changes the block's fill and nothing about its rows.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	type OutputBlockOptions,
	outputBlockContentWidth,
	renderOutputBlock,
} from "@veyyon/coding-agent/tui/output-block";
import { setAnsiPolicy, TERMINAL, type TUI, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

/** The one writable capability this suite drives; `TERMINAL` declares it readonly. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

const SRC = path.join(import.meta.dirname, "..", "src");

/** Rows with every escape sequence removed, so widths are ink and not bytes. */
function plain(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line));
}

/**
 * The states a block can be in, read out of the declaration at run time. A state
 * added to `State` and not to this sweep would otherwise be the one member whose
 * rail and plate nobody checked.
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

/** Every glyph a box was drawn out of, in the theme's own alphabet. */
function boxGlyphs(): string[] {
	const box = theme.boxSharp;
	return [box.topLeft, box.topRight, box.bottomLeft, box.bottomRight, box.vertical, box.teeLeft, box.teeRight];
}

/** The rail glyph, which is the one piece of chrome a block still draws. */
function rail(): string {
	return theme.symbol("block.rail");
}

describe("a tool block hangs its output on a rail, not in a box", () => {
	beforeAll(async () => {
		// Colour ON, and 24-bit. `theme.fg` returns its text unchanged when colour is
		// off, so the rail-colour arm below would compare nothing to nothing and pass on
		// a block whose rail was never tinted. COLORTERM is what carries it: the sandbox
		// runs with `TERM=dumb`, which `detectColorMode()` reads as a 256-colour
		// terminal, and the rail then arrives as `38;5;250` -- the palette approximation
		// of the same hex, which is a different assertion than the one this suite makes.
		Bun.env.COLORTERM = "truecolor";
		await initTheme(false);
		setAnsiPolicy("full");
		terminalCaps.trueColor = true;
	});

	it.each(SHAPES.map(shape => [shape.name, shape] as const))("%s draws no box", (_name, shape) => {
		const lines = plain(renderOutputBlock(shape.build(120), theme));
		// The corners and the walls are what a box IS. A rail is not one of them: the
		// vertical bar is in this set too, so swapping the rail glyph back to `│` fails
		// here rather than passing as "still no corners".
		for (const glyph of boxGlyphs()) {
			for (const line of lines) expect(line, `${glyph} in ${JSON.stringify(line)}`).not.toContain(glyph);
		}
	});

	it.each(SHAPES.map(shape => [shape.name, shape] as const))("%s rails every row under the title", (_name, shape) => {
		const options = shape.build(120);
		const lines = plain(renderOutputBlock(options, theme));
		// A shape with a header owns column 0 on that first row -- it carries the status
		// icon the caller built -- and every row under it is railed. A shape with NO
		// header has no such row, so all of its rows are body: reading the title off line
		// 0 regardless is how this arm used to demand a rail-free row from a block that
		// had none to give. A header with no sections is one line and no body at all,
		// which is the `set_cwd` shape asserted whole further down.
		const body = options.header === undefined ? lines : lines.slice(1);
		if (options.header !== undefined) expect(lines[0]?.startsWith(rail())).toBe(false);
		expect(body.length > 0, `${body.length} body rows`).toBe(options.sections !== undefined);
		for (const line of body) expect(line, JSON.stringify(line)).toStartWith(`${rail()} `);
	});

	it.each(SHAPES.map(shape => [shape.name, shape] as const))("%s stops well short of the terminal", (_name, shape) => {
		const lines = plain(renderOutputBlock(shape.build(120), theme));
		for (const line of lines) expect(visibleWidth(line), JSON.stringify(line)).toBeLessThan(100);
	});

	it("spends two columns on chrome, the same two the walls cost", () => {
		const lines = plain(renderOutputBlock({ width: 200, header: "T", sections: [{ lines: ["body"] }] }, theme));
		// rail + space + the default column of content padding.
		expect(lines[1]).toBe(`${rail()}  body`);
		expect(outputBlockContentWidth(200)).toBe(200 - 3);
	});

	it("is one line when a tool has nothing to show but its result", () => {
		// The `set_cwd` shape: a status line and no body. As a box that was three rows,
		// two of them chrome, for one fact.
		const lines = renderOutputBlock({ width: 120, header: "cwd · /srv/app" }, theme);
		expect(lines.length).toBe(1);
		expect(plain(lines)[0]).toBe("cwd · /srv/app");
	});

	it("spends no row on chrome above or below the output", async () => {
		const body = ["one", "two", "three"];
		const lines = renderOutputBlock({ width: 120, header: "T", sections: [{ lines: body }] }, theme);
		// Title plus one row per line of output. A box spent two more.
		expect(lines.length).toBe(body.length + 1);
		// And with no title at all, exactly the output.
		const bare = renderOutputBlock({ width: 120, sections: [{ lines: body }] }, theme);
		expect(bare.length).toBe(body.length);
	});

	it("keeps a header longer than its body whole", () => {
		const header = "Read a/very/long/path/that/is/wider/than/the/body.ts";
		const lines = plain(renderOutputBlock({ width: 200, header, sections: [{ lines: ["x"] }] }, theme));
		// The title is a line of its own now, so nothing about the body can crop it.
		expect(lines[0]).toBe(header);
	});

	it("wraps its body at the width a renderer budgets rows against", () => {
		const width = 40;
		const contentWidth = outputBlockContentWidth(width);
		const sentence = "one two three four five six seven eight nine ten eleven twelve thirteen".repeat(2);
		const lines = renderOutputBlock({ width, header: "T", sections: [{ lines: [sentence] }] }, theme);
		// The title, then the wrapped rows. Changing the wrap width would change this
		// count, and every renderer that sizes a tail window against
		// `outputBlockContentWidth` would overflow its intended height.
		expect(lines.length).toBe(wrapTextWithAnsi(sentence, contentWidth).length + 1);
	});

	it("never reaches past the terminal, even when a line fills every column it was wrapped to", () => {
		const width = 40;
		const line = "x".repeat(outputBlockContentWidth(width));
		const lines = plain(renderOutputBlock({ width, header: "T", sections: [{ lines: [line] }] }, theme));
		for (const row of lines) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		// And it really did use the room: the content row reaches the last column.
		expect(visibleWidth(lines[1]!)).toBe(width);
	});

	it("carries no trailing padding on an unpainted row", () => {
		const lines = renderOutputBlock({ width: 120, header: "T", sections: [{ lines: ["short"] }] }, theme);
		// A box padded every row out to its right wall. With no wall to reach, padding is
		// invisible ink the live-tail paint has to strip again and a copied transcript
		// keeps.
		for (const line of plain(lines)) expect(line).not.toEndWith(" ");
	});

	it("colours the rail from the state, and lets a caller override it", async () => {
		const expected: Record<string, string> = {
			error: theme.getColorHex("error"),
			warning: theme.getColorHex("warning"),
			running: theme.getColorHex("accent"),
			pending: theme.getColorHex("accent"),
			success: theme.getColorHex("dim"),
		};
		for (const state of await declaredStates()) {
			const lines = renderOutputBlock(
				{
					width: 120,
					header: "Read",
					state: state as OutputBlockOptions["state"],
					applyBg: false,
					sections: [{ lines: ["body"] }],
				},
				theme,
			);
			const hex = expected[state];
			if (hex === undefined) throw new Error(`State "${state}" has no recorded rail colour in this suite`);
			const { r, g, b } = { r: 1, g: 3, b: 5 };
			const channels = [hex.slice(r, r + 2), hex.slice(g, g + 2), hex.slice(b, b + 2)].map(part =>
				parseInt(part, 16),
			);
			expect(lines[1], state).toContain(`38;2;${channels.join(";")}`);
		}
		const overridden = renderOutputBlock(
			{
				width: 120,
				header: "Read",
				state: "error",
				borderColor: "dim",
				applyBg: false,
				sections: [{ lines: ["b"] }],
			},
			theme,
		);
		expect(overridden[1]).not.toContain(theme.getColorHex("error").slice(1, 3));
	});

	it("paints a state background as a plate the size of the block, not a band across the screen", async () => {
		for (const state of await declaredStates()) {
			const options: OutputBlockOptions = {
				width: 120,
				header: "Read src/parser.ts",
				state: state as OutputBlockOptions["state"],
				sections: [{ lines: ["export function parse() {}"] }],
			};
			const painted = plain(renderOutputBlock(options, theme));
			const widths = new Set(painted.map(visibleWidth));
			// One rectangle, and it is the block's own: a fill padded to the terminal is
			// the slab this class of defect always turns into.
			expect(widths.size, state).toBe(1);
			expect([...widths][0]!, state).toBeLessThan(100);
		}
	});

	it("paints no plate at all when the caller has already painted the ground", async () => {
		// A block nested in a surface that owns its own material asks for the state
		// colour without the fill. Without this, `applyBg` could stop being read and the
		// arm above would still pass: it only ever looks at rows that asked for a plate.
		for (const state of await declaredStates()) {
			const bare = renderOutputBlock(
				{
					width: 120,
					header: "Read src/parser.ts",
					state: state as OutputBlockOptions["state"],
					applyBg: false,
					sections: [{ lines: ["export function parse() {}"] }],
				},
				theme,
			);
			for (const row of bare) expect(row, `${state}: ${JSON.stringify(row)}`).not.toMatch(/\x1b\[4[08];/);
			// And the same block WITH the plate does carry one, so this is a difference and
			// not two ways of asserting that nothing is ever painted.
			const plated = renderOutputBlock(
				{
					width: 120,
					header: "Read src/parser.ts",
					state: state as OutputBlockOptions["state"],
					sections: [{ lines: ["export function parse() {}"] }],
				},
				theme,
			);
			expect(
				plated.some(row => /\x1b\[4[08];/.test(row)),
				state,
			).toBe(true);
		}
	});

	it("reaches the plate under a header wider than everything below it", () => {
		// The block takes its width from the widest thing in it, and the title is one of
		// those things. A plate measured off the body alone leaves the title hanging over
		// the edge of its own card, which is the half-painted version of the slab.
		const header = "Read a/very/long/path/that/is/wider/than/the/body.ts";
		const painted = plain(
			renderOutputBlock({ width: 120, header, state: "success", sections: [{ lines: ["x"] }] }, theme),
		);
		const widths = new Set(painted.map(visibleWidth));
		expect(widths.size).toBe(1);
		expect([...widths][0]!).toBeGreaterThan(visibleWidth(header));
	});

	it("grows with its content rather than staying pinned to the terminal", () => {
		const short = "!".repeat(20);
		const long = "!".repeat(60);
		const build = (line: string): string[] =>
			plain(renderOutputBlock({ width: 200, header: "T", state: "success", sections: [{ lines: [line] }] }, theme));
		// Both blocks are content-dominated, so the whole difference between them is the
		// difference between their bodies. A block taking its width from the terminal
		// reports 0 here: that was the defect the hug closed, and the rail keeps it closed
		// because a rail with a terminal-width plate behind it is the slab again.
		expect(visibleWidth(build(long)[0]!) - visibleWidth(build(short)[0]!)).toBe(40);
	});

	it("takes its width from its widest row plus the rail, and nothing more", () => {
		const body = ["a", "a much longer line than the first one", "mid"];
		const painted = plain(
			renderOutputBlock({ width: 200, header: "T", state: "success", sections: [{ lines: body }] }, theme),
		);
		const widestInk = Math.max(...body.map(visibleWidth));
		// Four columns, the same four a box spent, made of different things: two walls,
		// a column of left padding and a column of air on the right became a rail, the
		// space after it, that same left padding, and the same column of air. The air is
		// what keeps a painted plate from being text jammed against its own edge.
		expect(new Set(painted.map(visibleWidth))).toEqual(new Set([widestInk + 4]));
	});

	it("is the same block whether or not it is painted", async () => {
		for (const state of await declaredStates()) {
			const base: OutputBlockOptions = {
				width: 120,
				header: "Read src/parser.ts",
				state: state as OutputBlockOptions["state"],
				sections: [{ lines: ["export function parse() {}"] }],
			};
			const painted = plain(renderOutputBlock({ ...base, applyBg: true }, theme));
			const bare = plain(renderOutputBlock({ ...base, applyBg: false }, theme));
			// A plate is fill that squares the block off. It moves nothing: same rows, same
			// ink, same order. The rectangle it fills to is the widest row the unpainted
			// block already had, plus the one column of air at the right.
			expect(
				painted.map(row => row.trimEnd()),
				state,
			).toEqual(bare.map(row => row.trimEnd()));
			expect(new Set(painted.map(visibleWidth)).size, state).toBe(1);
			expect(visibleWidth(painted[0]!), state).toBe(Math.max(...bare.map(visibleWidth)) + 1);
		}
	});

	/**
	 * A real `ToolExecutionComponent` prints the block inside its OWN frame: a blank
	 * row above and below, a two-column gutter on the left, and every row padded out
	 * to the render width so the transcript has a rectangle to paint on. That frame
	 * belongs to the component and predates the rail, so it is asserted here instead
	 * of being stripped in silence -- and the rail has to be found at column 2, which
	 * is what these arms got wrong while the block underneath them was correct.
	 */
	function componentFrame(lines: readonly string[]): { railed: string[]; ink: string[] } {
		const rows = plain(lines);
		expect(rows.length, "a block the component printed with no frame").toBeGreaterThan(2);
		expect([...new Set(rows.map(visibleWidth))], "every row padded to the render width").toEqual([120]);
		expect(rows[0]?.trim(), "a blank row above").toBe("");
		expect(rows.at(-1)?.trim(), "a blank row below").toBe("");
		const ink = rows.filter(row => row.trim().length > 0);
		for (const row of ink) expect(row, JSON.stringify(row)).toStartWith("  ");
		return { railed: ink.filter(row => row.startsWith(`  ${rail()} `)), ink };
	}

	/**
	 * Both arms ask the same questions of two real tools, and `unrailed` is the count
	 * of ink rows that are NOT railed, measured per tool rather than assumed to be one:
	 * `read` prints a title row carrying its own status icon, and `bash` prints none at
	 * all -- its first row is the command, railed like the output under it.
	 */
	const REAL_BLOCKS: ReadonlyArray<{ name: string; unrailed: number; build: () => ToolExecutionComponent }> = [
		{
			name: "bash",
			unrailed: 0,
			build: () => {
				const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
				block.setArgsComplete();
				block.updateResult({
					content: [{ type: "text", text: "migrated 3 tables" }],
					details: { exitCode: 0 },
					isError: false,
				} as never);
				return block;
			},
		},
		{
			name: "read",
			unrailed: 1,
			build: () => {
				const block = createToolExecution("read", { path: "src/parser.ts" }, {}, undefined, ui);
				block.setArgsComplete();
				block.updateResult({
					content: [{ type: "text", text: "export function parse() {}" }],
					isError: false,
				} as never);
				return block;
			},
		},
	];

	it.each(REAL_BLOCKS.map(entry => [entry.name, entry] as const))(
		"rails a real %s block through the component that owns it",
		(_name, entry) => {
			const lines = entry.build().render(120);
			const { railed, ink } = componentFrame(lines);
			// Every row of output hangs on the rail; only the tool's own title row, when it
			// has one, owns column 0.
			expect(ink.length - railed.length, `${ink.length} ink rows, ${railed.length} railed`).toBe(entry.unrailed);
			for (const glyph of boxGlyphs()) {
				for (const line of plain(lines)) expect(line, `${glyph} in ${JSON.stringify(line)}`).not.toContain(glyph);
			}
			// The block hugs its own ink. The padding to the render width is the
			// component's rectangle; the block inside it stops less than halfway across.
			for (const row of ink) expect(visibleWidth(row.trimEnd()), JSON.stringify(row.trimEnd())).toBeLessThan(60);
		},
	);
});
