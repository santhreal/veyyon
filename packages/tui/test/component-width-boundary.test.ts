/**
 * Boundary tests for component rendering at pathological widths.
 *
 * A terminal can report a width of 0 or 1 (a split pane dragged to nothing, a
 * cold-start race), a negative/NaN width (a bad resize event), or a nonsense
 * huge/Infinite one (a miscomputed layout). Rendering must never throw at any
 * of these and must always return a string array — a render-path crash takes
 * down the whole TUI frame.
 *
 * Regression note: an Infinite (or multi-million) width reached
 * `String.prototype.repeat` via `padding()` and threw
 * `RangeError: … must not be Infinity`, crashing Text and Markdown. `padding()`
 * is now total (see utils.ts); these tests lock that.
 *
 * Deterministic LCG so a failing (content, width) pair reproduces from the seed.
 */
import { describe, expect, it } from "bun:test";
import { Markdown } from "@veyyon/pi-tui/components/markdown";
import { Text } from "@veyyon/pi-tui/components/text";
import { padding } from "@veyyon/pi-tui/utils";
import { buildString, lcg } from "./helpers/adversarial-strings";
import { defaultMarkdownTheme } from "./test-themes.js";

// Widths that break naive layout math: zero/one/two cols, negatives, NaN,
// Infinity, and the 32-bit cap the width primitives clamp against.
const PATHOLOGICAL_WIDTHS = [0, 1, 2, 3, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, 1e9, 0x7fff_ffff];

const renderText = (text: string, width: number): readonly string[] => new Text(text, 1, 0).render(width);
const renderMarkdown = (text: string, width: number): readonly string[] =>
	new Markdown(text, 0, 0, defaultMarkdownTheme).render(width);

describe("component rendering at pathological widths", () => {
	// 1200 iters x 10 widths = 12000 renders: enough fuzz to shake out a
	// width-math crash, comfortably under Bun's per-test timeout. The explicit
	// timeout is a floor so a slow CI host never flakes this coverage.
	it("Text never throws and returns a string array at any width", () => {
		const rand = lcg(0x7e_00_11);
		for (let iter = 0; iter < 1200; iter++) {
			const content = buildString(rand);
			for (const width of PATHOLOGICAL_WIDTHS) {
				let lines: readonly string[];
				try {
					lines = renderText(content, width);
				} catch (e) {
					throw new Error(`Text.render(${JSON.stringify(content)}, ${width}) threw: ${e}`);
				}
				expect(Array.isArray(lines)).toBe(true);
				for (const line of lines) expect(typeof line).toBe("string");
			}
		}
	}, 20000);

	// 1200 iters x 10 widths = 12000 markdown renders; same fuzz-vs-timeout
	// budget as the Text case above.
	it("Markdown never throws and returns a string array at any width", () => {
		const rand = lcg(0x7e_00_22);
		for (let iter = 0; iter < 1200; iter++) {
			const content = buildString(rand);
			for (const width of PATHOLOGICAL_WIDTHS) {
				let lines: readonly string[];
				try {
					lines = renderMarkdown(content, width);
				} catch (e) {
					throw new Error(`Markdown.render(${JSON.stringify(content)}, ${width}) threw: ${e}`);
				}
				expect(Array.isArray(lines)).toBe(true);
				for (const line of lines) expect(typeof line).toBe("string");
			}
		}
	}, 20000);

	// Direct regression on the primitive that crashed: padding() must be total —
	// no throw, no gigabyte allocation — for every out-of-contract argument.
	it("padding() is total: empty for non-positive/NaN, bounded for Infinity/huge", () => {
		expect(padding(0)).toBe("");
		expect(padding(-5)).toBe("");
		expect(padding(Number.NaN)).toBe("");
		expect(padding(Number.NEGATIVE_INFINITY)).toBe("");
		expect(padding(3)).toBe("   ");
		// Infinity and absurd finite widths must return a bounded string, not throw
		// or allocate multiple gigabytes.
		const inf = padding(Number.POSITIVE_INFINITY);
		expect(inf.length).toBeGreaterThan(0);
		expect(inf.length).toBeLessThanOrEqual(1 << 20);
		expect(/^ +$/.test(inf)).toBe(true);
		expect(padding(0x7fff_ffff).length).toBeLessThanOrEqual(1 << 20);
	});
});
