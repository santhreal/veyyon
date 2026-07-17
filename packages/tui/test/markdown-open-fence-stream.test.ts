/**
 * Incremental finished-row path for the OPEN code fence ending a streaming
 * render (OpenFenceRowCache). Contract: the streamed (append-cached) render is
 * byte-identical to a fresh render of the same text, at every frame, for plain
 * and diff-family fences, across width changes, and through fence close.
 */
import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown, type MarkdownTheme } from "@veyyon/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 72;

function renderFresh(text: string, width: number, theme: MarkdownTheme = defaultMarkdownTheme): readonly string[] {
	clearRenderCache();
	const md = new Markdown(text, 0, 0, theme);
	md.transientRenderCache = true;
	return md.render(width);
}

describe("Markdown open-fence streaming rows", () => {
	it("streamed plain-language fence renders byte-identical to fresh at every frame", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		let text = "intro paragraph\n\n```ts\n";
		for (let t = 0; t < 120; t++) {
			// Mix newline-terminated lines with an in-progress open line, and
			// include a line long enough to wrap at WIDTH.
			text += t % 7 === 6 ? `const wide${t} = "${"x".repeat(90)}";\n` : `const v${t} = ${t}; // c${t}\n`;
			if (t % 5 === 0) text += "partial";
			md.setText(text);
			expect(md.render(WIDTH)).toEqual(renderFresh(text, WIDTH));
			if (t % 5 === 0) {
				text += " line finished\n";
				md.setText(text);
				expect(md.render(WIDTH)).toEqual(renderFresh(text, WIDTH));
			}
		}
	});

	it("streamed diff fence keeps per-line highlighting byte-identical to fresh", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		let text = "```diff\n";
		for (let t = 0; t < 60; t++) {
			text += t % 2 === 0 ? `+ added line ${t}\n` : `- removed line ${t}\n`;
			md.setText(text);
			expect(md.render(WIDTH)).toEqual(renderFresh(text, WIDTH));
		}
	});

	it("recovers byte-identically when the render width changes mid-stream", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		let text = "```py\n";
		for (let t = 0; t < 30; t++) {
			text += `value_${t} = ${t * 3}\n`;
			md.setText(text);
			md.render(WIDTH);
		}
		expect(md.render(40)).toEqual(renderFresh(text, 40));
		text += "tail_line = 1\n";
		md.setText(text);
		expect(md.render(40)).toEqual(renderFresh(text, 40));
		expect(md.render(WIDTH)).toEqual(renderFresh(text, WIDTH));
	});

	it("matches the generic path once the fence closes and prose continues", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		let text = "```ts\n";
		for (let t = 0; t < 40; t++) {
			text += `const v${t} = ${t};\n`;
			md.setText(text);
			md.render(WIDTH);
		}
		// Closing the fence exits the open-fence fast path; the closed fence
		// and the prose after it must match a fresh render exactly.
		text += "```\n\nclosing prose after the fence";
		md.setText(text);
		expect(md.render(WIDTH)).toEqual(renderFresh(text, WIDTH));
	});

	it("handles a shrink/rewrite (non-append) by rebuilding, byte-identical to fresh", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		let text = "```ts\n";
		for (let t = 0; t < 25; t++) {
			text += `const v${t} = ${t};\n`;
			md.setText(text);
			md.render(WIDTH);
		}
		const rewritten = "```ts\nconst rewritten = true;\nconst second = 2;\npartial";
		md.setText(rewritten);
		expect(md.render(WIDTH)).toEqual(renderFresh(rewritten, WIDTH));
	});
});
