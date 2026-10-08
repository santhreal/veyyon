import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown, type MarkdownTheme } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 72;
const FROZEN_CODE_PREFIX = "```ts\nconst frozen = 1;\n```\n\n";

function renderCold(text: string, theme: MarkdownTheme): readonly string[] {
	clearRenderCache();
	const md = new Markdown(text, 0, 0, theme);
	return md.render(WIDTH);
}

describe("Markdown streaming prefix render cache", () => {
	it("reuses rendered frozen prefix lines during transient append renders", () => {
		let codeBlockCalls = 0;
		let codeBlockBorderCalls = 0;
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlock: text => {
				codeBlockCalls++;
				return defaultMarkdownTheme.codeBlock(text);
			},
			codeBlockBorder: text => {
				codeBlockBorderCalls++;
				return defaultMarkdownTheme.codeBlockBorder(text);
			},
		};

		const firstText = `${FROZEN_CODE_PREFIX}tail one`;
		const secondText = `${FROZEN_CODE_PREFIX}tail one plus more streamed words`;
		const md = new Markdown(firstText, 0, 0, theme);
		md.transientRenderCache = true;
		md.render(WIDTH);

		codeBlockCalls = 0;
		codeBlockBorderCalls = 0;
		md.setText(secondText);
		const streamingLines = md.render(WIDTH);

		expect(codeBlockCalls).toBe(0);
		expect(codeBlockBorderCalls).toBe(0);
		expect(streamingLines).toEqual(renderCold(secondText, theme));
	});

	it("advances the rendered prefix cache when a new stable block freezes", () => {
		let codeBlockCalls = 0;
		let codeBlockBorderCalls = 0;
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlock: text => {
				codeBlockCalls++;
				return defaultMarkdownTheme.codeBlock(text);
			},
			codeBlockBorder: text => {
				codeBlockBorderCalls++;
				return defaultMarkdownTheme.codeBlockBorder(text);
			},
		};
		const firstBlock = "```ts\nconst first = 1;\n```\n\n";
		const secondBlock = "```ts\nconst second = 2;\n```\n\n";
		const firstText = `${firstBlock}first tail`;
		const secondText = `${firstBlock}${secondBlock}second tail`;
		const thirdText = `${firstBlock}${secondBlock}second tail plus more words`;
		const md = new Markdown(firstText, 0, 0, theme);
		md.transientRenderCache = true;
		md.render(WIDTH);

		md.setText(secondText);
		md.render(WIDTH);

		codeBlockCalls = 0;
		codeBlockBorderCalls = 0;
		md.setText(thirdText);
		const streamingLines = md.render(WIDTH);

		expect(codeBlockCalls).toBe(0);
		expect(codeBlockBorderCalls).toBe(0);
		expect(streamingLines).toEqual(renderCold(thirdText, theme));
	});

	it("drops cached prefix lines after truncating to a previously frozen prefix", () => {
		const prefix = "---\n\n";
		const md = new Markdown(`${prefix}body`, 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		md.render(WIDTH);

		md.setText(prefix);
		const streamingLines = md.render(WIDTH);

		expect(streamingLines).toEqual(renderCold(prefix, defaultMarkdownTheme));
	});

	it("serves frozen rows only while their text still leads the transcript, through rewinds, edits and resizes", () => {
		// The frozen rows are reused when the text they were rendered for is the frozen prefix, the
		// prefix it was cut to extend, or found to lead it. A reuse decided wrong paints rows of text
		// that is no longer there. The sequence mixes appends with the ways a transcript stops
		// extending the one the rows were cut from: a rewind, an edit inside a frozen block, a
		// different width, and a fresh start.
		const blocks = [
			"Paragraph about the render loop.\n\n",
			"```ts\nconst frozen = 1;\n```\n\n",
			"- first item\n- second item\n\n",
			"## A heading\n\n",
			"> quoted line\n\n",
			"Words without a blank line after them ",
		];
		let state = 0x2f6b9c1d;
		const next = (): number => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x100000000;
		};
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		let text = "";
		let width = WIDTH;
		const diverged: { step: number; text: string; width: number }[] = [];
		for (let step = 0; step < 400 && diverged.length === 0; step++) {
			const roll = next();
			if (roll < 0.6) text += blocks[Math.floor(next() * blocks.length)]!;
			else if (roll < 0.75) text = text.slice(0, Math.floor(next() * text.length));
			else if (roll < 0.87 && text.length > 0) {
				const at = Math.floor(next() * (text.length / 2));
				text = `${text.slice(0, at)}Z${text.slice(at + 1)}`;
			} else if (roll < 0.97) width = [WIDTH, 40, 100][Math.floor(next() * 3)]!;
			else text = "";
			md.setText(text);
			const streamed = [...md.render(width)];
			clearRenderCache();
			const cold = new Markdown(text, 0, 0, defaultMarkdownTheme).render(width);
			if (JSON.stringify(streamed) !== JSON.stringify(cold)) diverged.push({ step, text, width });
		}
		expect(diverged).toEqual([]);
	});
});
