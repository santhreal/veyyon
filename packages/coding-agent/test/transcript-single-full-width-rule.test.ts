/**
 * The composer's hairline is the only full-width rule on screen.
 *
 * One rule separates the transcript from the input, and it earns its width by
 * being the boundary between two regions. Tool and execution blocks used to fence
 * themselves with a full-bleed rule above and below, which at 120 columns cut the
 * transcript into slabs, competed with the composer's rule for the same meaning,
 * and carried no information — a passing run and a failing run were fenced
 * identically. The V1 aligned-quiet merge removed them (user-approved 2026-07-22)
 * and put every block on the shared left rail instead.
 *
 * Nothing stopped them coming back, so this suite is the lock. It asserts on
 * RENDERED lines rather than on source shape, because the fences were rendered
 * from three different places and a grep for any one of them would miss the next.
 *
 * A "full-width rule" here means a line whose entire visible content is the
 * horizontal box glyph, edge to edge. A box border is deliberately NOT that: it
 * carries corners, and often a label, so it reads as a frame around content rather
 * than as a divider between regions.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/components/bash-execution";
import { ComposerHairline } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Component, TUI } from "@veyyon/tui";

const WIDTHS = [80, 120, 200];

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme();
});

/**
 * Lines that are nothing but the horizontal rule glyph, spanning the width.
 *
 * Corners and labels disqualify a line: those make it a frame, not a divider.
 * Trailing padding is ignored, since the renderer pads every line to the width.
 */
function fullWidthRules(component: Component, width: number): string[] {
	const rule = theme.boxSharp.horizontal;
	return component
		.render(width)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
		.filter(line => line.length >= width - 1 && line.split("").every(char => char === rule));
}

function bashBlock(exitCode: number | undefined): Component {
	const block = new BashExecutionComponent("grep zzz missing.txt", uiStub);
	block.appendOutput("no matches\n");
	block.setComplete(exitCode, false);
	return block;
}

function toolBlock(isError: boolean): Component {
	const block = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub);
	block.updateResult({ content: [{ type: "text", text: "a\nb" }], isError } as never, false);
	return block;
}

describe("the composer hairline", () => {
	/** Proves the detector can see a full-width rule at all. Without this, every
	 * assertion below would pass on a detector that finds nothing anywhere. */
	it("renders exactly one, at every width", () => {
		for (const width of WIDTHS) {
			expect(fullWidthRules(new ComposerHairline(), width), `width ${width}`).toHaveLength(1);
		}
	});
});

describe("transcript blocks", () => {
	it("a completed bash execution renders none", () => {
		for (const width of WIDTHS) {
			expect(fullWidthRules(bashBlock(0), width), `width ${width}`).toEqual([]);
		}
	});

	/** A failure is where a fence would be most tempting, and it is exactly where
	 * the old pair carried no information: both outcomes were fenced the same. */
	it("a failed bash execution renders none", () => {
		for (const width of WIDTHS) {
			expect(fullWidthRules(bashBlock(1), width), `width ${width}`).toEqual([]);
		}
	});

	it("a tool execution renders none, passing or failing", () => {
		for (const width of WIDTHS) {
			expect(fullWidthRules(toolBlock(false), width), `width ${width}`).toEqual([]);
			expect(fullWidthRules(toolBlock(true), width), `width ${width}`).toEqual([]);
		}
	});

	/** The framed tool blocks DO draw a box, and that is fine: it has corners and a
	 * label, so it frames content instead of dividing the screen. Asserting it is
	 * present keeps this suite from passing because the blocks render nothing. */
	it("still draws its framed box around the output", () => {
		const lines = toolBlock(false)
			.render(120)
			.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(lines.some(line => line.includes(theme.boxSharp.topLeft))).toBe(true);
		expect(lines.some(line => line.includes(theme.boxSharp.bottomRight))).toBe(true);
	});
});
