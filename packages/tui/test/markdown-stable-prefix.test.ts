/**
 * RenderStablePrefix contract on Markdown: while streaming, the leading rows
 * covered by the frozen-prefix line cache are reported stable so the engine
 * can skip re-ingesting them. Core invariant: every row before the report is
 * value-identical, at the same index, to the previously returned render array.
 */
import { describe, expect, it } from "bun:test";
import { Markdown } from "@veyyon/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 60;

function streamingMarkdown(paddingY = 1): Markdown {
	const md = new Markdown("", 0, paddingY, defaultMarkdownTheme);
	md.transientRenderCache = true;
	return md;
}

describe("Markdown stable-prefix report", () => {
	it("reported rows are value-identical to the previous render at every streamed frame", () => {
		const md = streamingMarkdown();
		let text = "";
		let observed: readonly string[] = [];
		let sawPositiveReport = false;
		for (let t = 0; t < 80; t++) {
			// Paragraphs separated by hard "\n\n" boundaries freeze; the tail
			// stays volatile. Mix in a fence to cross block types.
			text += t % 9 === 8 ? `\n\n\`\`\`ts\nconst x${t} = ${t};\n\`\`\`\n\n` : `word${t} `;
			md.setText(text);
			const rows = md.render(WIDTH);
			const report = md.getRenderStablePrefixRows(rows);
			expect(report).toBeLessThanOrEqual(Math.min(rows.length, observed.length || 0));
			for (let i = 0; i < report; i++) expect(rows[i]).toBe(observed[i] as string);
			if (report > 0) sawPositiveReport = true;
			observed = rows;
		}
		// The report must actually engage on a long stream, not stay at zero.
		expect(sawPositiveReport).toBe(true);
	});

	it("drops the report to zero after a rewind (non-append edit)", () => {
		const md = streamingMarkdown();
		let text = "";
		for (let t = 0; t < 30; t++) {
			text += t % 6 === 5 ? "tail.\n\nNext paragraph " : `tok${t} `;
			md.setText(text);
			md.getRenderStablePrefixRows(md.render(WIDTH));
		}
		md.setText("completely different text\n\nwith new blocks entirely rewritten");
		expect(md.getRenderStablePrefixRows(md.render(WIDTH))).toBe(0);
	});

	it("reports zero for an array it did not return", () => {
		const md = streamingMarkdown();
		md.setText("alpha\n\nbeta gamma");
		const rows = md.render(WIDTH);
		md.getRenderStablePrefixRows(rows);
		expect(md.getRenderStablePrefixRows(rows.slice())).toBe(0);
		// The mismatch resets the accumulator instead of resurrecting the claim.
		expect(md.getRenderStablePrefixRows(rows)).toBe(0);
	});

	it("a width change between reads yields a zero report", () => {
		const md = streamingMarkdown();
		let text = "";
		for (let t = 0; t < 20; t++) {
			text += t === 9 ? "end.\n\nNew block " : `tok${t} `;
			md.setText(text);
			md.getRenderStablePrefixRows(md.render(WIDTH));
		}
		md.setText(`${text}more`);
		expect(md.getRenderStablePrefixRows(md.render(WIDTH - 10))).toBe(0);
	});

	it("accumulates the minimum across renders between reads", () => {
		const md = streamingMarkdown();
		let text = "";
		for (let t = 0; t < 20; t++) {
			text += t === 9 ? "end.\n\nNew block " : `tok${t} `;
			md.setText(text);
			md.getRenderStablePrefixRows(md.render(WIDTH));
		}
		// Append (would keep the frozen prefix), then rewind (keeps nothing),
		// with no read in between: the eventual report is the interval minimum.
		md.setText(`${text}grown`);
		md.render(WIDTH);
		md.setText("rewound to something else\n\nentirely");
		expect(md.getRenderStablePrefixRows(md.render(WIDTH))).toBe(0);
	});
});
