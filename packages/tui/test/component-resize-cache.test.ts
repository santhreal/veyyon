/**
 * Resize-storm cache-correctness for width-cached components.
 *
 * Text and Markdown memoize render output keyed on (text, width) — an L1
 * per-instance cache plus, for Markdown, an L2 module LRU and a streaming
 * prefix cache. A resize storm (a pane dragged, rapid SIGWINCH) drives one
 * instance through many widths back and forth. The invariant: render(w) on a
 * resized instance must byte-equal a *fresh* instance's render(w) — the caches
 * may only accelerate, never leak a stale-width frame into a later width.
 *
 * Deterministic LCG so a failing width sequence reproduces from the seed.
 */
import { describe, it } from "bun:test";
import { Markdown } from "@veyyon/tui/components/markdown";
import { Text } from "@veyyon/tui/components/text";
import { buildString, lcg } from "./helpers/adversarial-strings";
import { defaultMarkdownTheme } from "./test-themes.js";

// A spread of realistic terminal widths plus a couple of tight ones.
const WIDTHS = [1, 2, 8, 20, 40, 80, 120, 200];

function shuffledStorm(rand: () => number, length: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < length; i++) out.push(WIDTHS[Math.floor(rand() * WIDTHS.length)]!);
	return out;
}

describe("resize-storm cache correctness", () => {
	it("Text: a resized instance renders each width identically to a fresh one", () => {
		const rand = lcg(0x5e_51_2e_00);
		for (let iter = 0; iter < 3000; iter++) {
			const content = buildString(rand);
			const resized = new Text(content, 1, 0);
			for (const width of shuffledStorm(rand, 12)) {
				const stormed = resized.render(width).join("\n");
				const fresh = new Text(content, 1, 0).render(width).join("\n");
				if (stormed !== fresh) {
					throw new Error(`Text resize mismatch at width ${width} for ${JSON.stringify(content)}`);
				}
			}
		}
	});

	it("Markdown: a resized instance renders each width identically to a fresh one", () => {
		const rand = lcg(0x5e_51_2e_11);
		for (let iter = 0; iter < 2000; iter++) {
			const content = buildString(rand);
			const resized = new Markdown(content, 0, 0, defaultMarkdownTheme);
			for (const width of shuffledStorm(rand, 12)) {
				const stormed = resized.render(width).join("\n");
				const fresh = new Markdown(content, 0, 0, defaultMarkdownTheme).render(width).join("\n");
				if (stormed !== fresh) {
					throw new Error(`Markdown resize mismatch at width ${width} for ${JSON.stringify(content)}`);
				}
			}
		}
	});

	it("Markdown streaming cache: append-then-resize matches a fresh render of the final text", () => {
		// transientRenderCache freezes a stable prefix as text grows; a width change
		// mid-stream must not serve a frame wrapped at the old width.
		const rand = lcg(0x5e_51_2e_22);
		for (let iter = 0; iter < 1500; iter++) {
			const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
			streamed.transientRenderCache = true;
			let text = "";
			const chunks = 1 + Math.floor(rand() * 5);
			let finalWidth = 80;
			for (let c = 0; c < chunks; c++) {
				text += buildString(rand, 8);
				streamed.setText(text);
				const width = WIDTHS[Math.floor(rand() * WIDTHS.length)]!;
				finalWidth = width;
				streamed.render(width);
			}
			const stormed = streamed.render(finalWidth).join("\n");
			const fresh = new Markdown(text, 0, 0, defaultMarkdownTheme);
			fresh.transientRenderCache = true;
			const expected = fresh.render(finalWidth).join("\n");
			if (stormed !== expected) {
				throw new Error(`Markdown streaming resize mismatch at width ${finalWidth} for ${JSON.stringify(text)}`);
			}
		}
	});
});
