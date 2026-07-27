/**
 * Every transcript block starts on the same left rail.
 *
 * The design language states the rule and the reason: everything shares the composer
 * inset (`COMPOSER_INSET_COLS`), nothing sits at column 0, and "a flush-left line
 * next to inset ones reads as a misalignment, not a choice"
 * (docs/internal/tui-design-language.md). Framed tool cards were the exception. They
 * drew their border at column 0 while the composer gutter, the past-prompt glyph,
 * assistant prose and every bash header sat at column 2, so a card interrupted the
 * one edge the eye follows down the screen.
 *
 * Nothing caught it, because the rail is a property of the RENDERED line and each
 * component chose its own inset privately: reading the source told you a Box had
 * `paddingX` 0 or 1 or 2, not which column that put on screen next to its
 * neighbours. So this suite measures the rendered output, block by block, and pins
 * the column. It was written from an image proof of the real components stacked at
 * one width with a column ruler, which is how the misalignment was found
 * (`scripts/demos/render-transcript-rail.ts` reproduces it; never a terminal
 * capture, which renders on its own ground and hides exactly this class of thing).
 *
 * The column is asserted as the exact value rather than "greater than zero", because
 * a block at column 1 or 3 is just as misaligned as one at column 0 and would sail
 * past a looser check.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/components/bash-execution";
import { COMPOSER_INSET_COLS, resolveComposerAccents } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Component, TUI } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

const WIDTHS = [72, 120, 200];
const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme();
});

/** Rendered lines with styling removed, blank lines dropped. */
function visibleLines(component: Component, width: number): string[] {
	return component
		.render(width)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, ""))
		.filter(line => line.trim().length > 0);
}

/** The column each rendered line's content begins at. */
function startColumns(component: Component, width: number): number[] {
	return visibleLines(component, width).map(line => line.length - line.trimStart().length);
}

function bashBlock(exitCode: number): Component {
	const block = new BashExecutionComponent("bun test test/parser.test.ts", uiStub);
	block.appendOutput("1 pass\n1 fail\n");
	block.setComplete(exitCode, false);
	return block;
}

/** A tool card: the block that used to render flush at column 0. */
function toolBlock(isError: boolean): Component {
	const block = createToolExecution("read", { path: "src/parser.ts" }, {}, undefined, uiStub);
	block.updateResult({ content: [{ type: "text", text: "export function parse() {}" }], isError } as never, false);
	return block;
}

describe("the rail is the composer inset", () => {
	/** The value the whole rule is stated in terms of. If this moves, every
	 * assertion below moves with it, which is the point of having one owner. */
	it("is two columns, owned by composer-chrome", () => {
		expect(COMPOSER_INSET_COLS).toBe(2);
	});

	/** The composer's own gutter is what the transcript is aligned TO, so it is
	 * measured here rather than assumed: `"  " + glyph + " "`. */
	it("puts the composer's prompt glyph on it", () => {
		const accents = resolveComposerAccents({
			bypass: false,
			bashMode: false,
			pythonMode: false,
			planMode: false,
			focusedSubagent: false,
			sessionAccentAnsi: undefined,
			thinkingLevel: "off",
		});
		const gutter = accents.promptGutter.replace(/\x1b\[[0-9;]*m/g, "");

		expect(gutter.length - gutter.trimStart().length).toBe(COMPOSER_INSET_COLS);
	});
});

describe("a tool card", () => {
	/** THE regression. The card's frame drew at column 0 next to blocks at column 2. */
	it("starts its frame on the rail, not at column 0", () => {
		for (const width of WIDTHS) {
			const columns = startColumns(toolBlock(false), width);

			expect(columns.length, `width ${width}`).toBeGreaterThan(0);
			expect(Math.min(...columns), `width ${width}`).toBe(COMPOSER_INSET_COLS);
		}
	});

	it("starts on the rail when the tool failed, too", () => {
		for (const width of WIDTHS) {
			expect(Math.min(...startColumns(toolBlock(true), width)), `width ${width}`).toBe(COMPOSER_INSET_COLS);
		}
	});

	/** The whole card moves, not just its first row: a frame whose top rule was
	 * inset while its body stayed flush would be worse than either. */
	it("puts every one of its rows at or beyond the rail", () => {
		for (const width of WIDTHS) {
			for (const column of startColumns(toolBlock(false), width)) {
				expect(column, `width ${width}`).toBeGreaterThanOrEqual(COMPOSER_INSET_COLS);
			}
		}
	});

	/** The card keeps a right inset that mirrors the left, so it reads as a card in
	 * a column of text rather than a band across the terminal. */
	it("stops short of the right edge by the same inset", () => {
		const width = 120;
		const widest = Math.max(...visibleLines(toolBlock(false), width).map(line => line.trimEnd().length));

		expect(widest).toBeLessThanOrEqual(width - COMPOSER_INSET_COLS);
	});
});

describe("the blocks the card sits among", () => {
	it("a bash execution starts on the rail", () => {
		for (const width of WIDTHS) {
			expect(Math.min(...startColumns(bashBlock(0), width)), `width ${width}`).toBe(COMPOSER_INSET_COLS);
		}
	});

	/** A failed run is where a component is most tempted to shout by breaking the
	 * grid. It must not: the failure is carried by the marker, not by the geometry. */
	it("a failed bash execution starts on the rail", () => {
		for (const width of WIDTHS) {
			expect(Math.min(...startColumns(bashBlock(1), width)), `width ${width}`).toBe(COMPOSER_INSET_COLS);
		}
	});

	/**
	 * The composite claim, and the one a reader should trust: put the two block
	 * kinds side by side at one width and every rendered line agrees on where the
	 * transcript begins. This is what the image proof shows, asserted in bytes.
	 */
	it("agree with each other and with the composer on one column", () => {
		for (const width of WIDTHS) {
			const columns = [
				...startColumns(toolBlock(false), width),
				...startColumns(bashBlock(1), width),
				...startColumns(toolBlock(true), width),
			];

			expect(Math.min(...columns), `width ${width}`).toBe(COMPOSER_INSET_COLS);
			expect(
				columns.filter(column => column === 0),
				`width ${width}`,
			).toEqual([]);
		}
	});
});
