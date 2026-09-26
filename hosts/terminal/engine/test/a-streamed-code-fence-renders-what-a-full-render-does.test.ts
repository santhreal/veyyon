/**
 * WHY: a transient (streaming) render of a Markdown block that ends inside an open code fence keeps
 * the laid-out rows of the fence's complete lines from one frame to the next, and lays out only the
 * lines that completed since. Before that, every frame re-wrapped and re-padded every line of the
 * fence, so a streamed fence of N lines cost N² row layouts.
 *
 * The class this closes: a reused row that no longer matches what a full render of the same text
 * produces. Every way the reused rows can go stale is driven here against a cold, non-streaming render
 * of the same text as the reference: growth at every chunk size including one character, a width
 * change, padding and a background style, a rewind to an edited earlier line, a closed fence followed
 * by a second fence whose body repeats the first, the streaming flag toggled off and on, and the
 * OSC 66 layout state that carries from row to row: a sized heading ahead of the fence, an OSC 66
 * span inside the fence, and an opening fence row the theme draws as an OSC 66 span. A diff fence,
 * whose complete lines are highlighted while it streams, is held to a full render under a theme that
 * styles plain and highlighted lines alike, to its own highlighting under one that does not, and to a
 * fresh render when a fence in another language laid out the same lines first. A Mermaid diagram the
 * theme draws is held to a full render. The bound tests fail when each frame lays out the whole fence
 * again.
 *
 * Not caught: a theme whose `codeBlock` output for a line changes between frames without the theme
 * identity changing. The reuse assumes a line styles the same way for the life of a stream.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { clearRenderCache, type DefaultTextStyle, Markdown, type MarkdownTheme } from "@veyyon/tui/components/markdown";
import { setTerminalTextSizing } from "@veyyon/tui/terminal-capabilities";
import { OSC66 } from "@veyyon/utils/ansi";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 60;
const BACKGROUND: DefaultTextStyle = { bgColor: text => `\x1b[48;5;236m${text}\x1b[49m` };

/** A fence body with short lines, blank lines, indentation and lines wider than {@link WIDTH}. */
const FENCE_BODY = Array.from({ length: 24 }, (_, i) => {
	if (i % 7 === 3) return "";
	if (i % 5 === 1) return `  const wide${i} = "${"x".repeat(WIDTH + 17)}";`;
	return `const v${i} = ${(i * 7) % 100}; // line ${i}`;
}).join("\n");

interface Frame {
	text: string;
	width: number;
}

/** Construction options shared by the streaming instance and its cold reference. */
interface Layout {
	style?: DefaultTextStyle;
	/** An indent of 0 lets an empty code line lay out as an empty row, which the OSC 66 state acts on. */
	codeBlockIndent?: number;
}

function createMarkdown(text: string, theme: MarkdownTheme, layout: Layout): Markdown {
	return new Markdown(text, 2, 1, theme, layout.style, layout.codeBlockIndent);
}

function renderCold(text: string, width: number, theme: MarkdownTheme, layout: Layout = {}): readonly string[] {
	clearRenderCache();
	return createMarkdown(text, theme, layout).render(width);
}

/** Render every frame on one streaming instance and require each to equal a cold full render. */
function expectFramesMatchColdRender(frames: readonly Frame[], theme: MarkdownTheme, layout: Layout = {}): void {
	const md = createMarkdown("", theme, layout);
	md.transientRenderCache = true;
	for (const frame of frames) {
		md.setText(frame.text);
		const streamed = md.render(frame.width);
		expect(streamed, `frame ${JSON.stringify(frame.text.slice(-40))} at width ${frame.width}`).toEqual(
			renderCold(frame.text, frame.width, theme, layout),
		);
	}
}

function growthFrames(prefix: string, body: string, chunk: number, width = WIDTH): Frame[] {
	const frames: Frame[] = [];
	for (let end = 0; end <= body.length; end += chunk) frames.push({ text: prefix + body.slice(0, end), width });
	frames.push({ text: prefix + body, width });
	return frames;
}

afterEach(() => {
	setTerminalTextSizing(false);
});

describe("a streamed code fence renders the rows a full render does", () => {
	for (const chunk of [1, 7, 64]) {
		it(`at every frame while the fence grows ${chunk} characters at a time`, () => {
			expectFramesMatchColdRender(
				growthFrames("Intro paragraph.\n\n```ts\n", FENCE_BODY, chunk),
				defaultMarkdownTheme,
			);
		});
	}

	it("when the fence is the whole block, padded and on a background", () => {
		expectFramesMatchColdRender(growthFrames("```\n", FENCE_BODY, 5), defaultMarkdownTheme, { style: BACKGROUND });
	});

	it("when the width changes while the fence is open", () => {
		const frames = growthFrames("Intro.\n\n```ts\n", FENCE_BODY, 11).map((frame, i) => ({
			...frame,
			width: [WIDTH, 24, WIDTH, 97][i % 4],
		}));
		expectFramesMatchColdRender(frames, defaultMarkdownTheme);
	});

	it("when the text rewinds to an edited earlier line", () => {
		const prefix = "Intro.\n\n```ts\n";
		const edited = FENCE_BODY.replace("const v2 =", "let edited =");
		const frames = [
			...growthFrames(prefix, FENCE_BODY, 13),
			...growthFrames(prefix, edited, 13),
			{ text: prefix + FENCE_BODY.slice(0, 40), width: WIDTH },
			{ text: prefix + FENCE_BODY, width: WIDTH },
		];
		expectFramesMatchColdRender(frames, defaultMarkdownTheme);
	});

	it("when a fence closes and a second fence repeats the first one's lines", () => {
		const first = `Intro.\n\n\`\`\`ts\n${FENCE_BODY}\n\`\`\`\n\nBetween.\n\n\`\`\`ts\n`;
		expectFramesMatchColdRender(
			[...growthFrames("Intro.\n\n```ts\n", FENCE_BODY, 17), ...growthFrames(first, FENCE_BODY, 17)],
			defaultMarkdownTheme,
		);
	});

	it("when streaming is switched off and on again mid-fence", () => {
		const prefix = "Intro.\n\n```ts\n";
		const md = new Markdown("", 2, 1, defaultMarkdownTheme);
		md.transientRenderCache = true;
		for (const [i, frame] of growthFrames(prefix, FENCE_BODY, 19).entries()) {
			md.transientRenderCache = i % 5 !== 4;
			md.setText(frame.text);
			expect(md.render(frame.width)).toEqual(renderCold(frame.text, frame.width, defaultMarkdownTheme));
		}
	});

	it("after an OSC 66 sized heading", () => {
		setTerminalTextSizing(true);
		expectFramesMatchColdRender(growthFrames("# Title\n```ts\n", FENCE_BODY, 9), defaultMarkdownTheme);
	});

	it("when a fence line holds an OSC 66 span and the next line is empty", () => {
		// The empty row after an OSC 66 row is left unpadded, so the layout state after the last
		// reused row decides how the next line is laid out.
		const body = `a\n${OSC66}s=2;X\x07\n\nb\n${OSC66}s=2;Y\x07\n\nc`;
		expectFramesMatchColdRender(growthFrames("Intro.\n\n```ts\n", body, 1), defaultMarkdownTheme, {
			style: BACKGROUND,
			codeBlockIndent: 0,
		});
	});

	it("when the theme draws an opening fence as an OSC 66 row and a second fence repeats the first", () => {
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlockFence: (lang, pos) =>
				lang === "sized" && pos === "open"
					? `${OSC66}s=2;sized\x07`
					: pos === "open"
						? `\`\`\`${lang ?? ""}`
						: "```",
		};
		const first = "Intro.\n\n```ts\n\nx\ny";
		expectFramesMatchColdRender(
			[
				{ text: first, width: WIDTH },
				{ text: `${first}\n\`\`\`\n\n\`\`\`sized\n\nx\nz`, width: WIDTH },
			],
			theme,
			{ codeBlockIndent: 0 },
		);
	});

	it("for a Mermaid fence the theme draws as a diagram", () => {
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			resolveMermaidAscii: source => `DIAGRAM ${source.split("\n").length} lines`,
		};
		expectFramesMatchColdRender(growthFrames("Intro.\n\n```mermaid\n", "graph TD\nA-->B\nB-->C\n", 3), theme);
	});
});

/** Highlights each line with a marker the plain `codeBlock` style does not add. */
const DIFF_THEME: MarkdownTheme = {
	...defaultMarkdownTheme,
	highlightCode: code => code.split("\n").map(line => `HL:${line}`),
};

/**
 * Styles a plain line and a highlighted one alike, so a stream that highlights only its complete
 * lines renders what a full render that highlights every line does.
 */
const UNIFORM_DIFF_THEME: MarkdownTheme = { ...DIFF_THEME, codeBlock: line => `HL:${line}` };

const DIFF_BODY = Array.from({ length: 18 }, (_, i) =>
	i % 6 === 2 ? "" : `${i % 2 ? "+" : "-"}${i % 5 === 0 ? "w".repeat(WIDTH + 9) : `line ${i}`}`,
).join("\n");

function renderFresh(text: string, width: number, theme: MarkdownTheme): readonly string[] {
	clearRenderCache();
	const md = new Markdown(text, 2, 1, theme);
	md.transientRenderCache = true;
	return md.render(width);
}

describe("a streamed diff fence", () => {
	it("highlights its complete lines and leaves the line still streaming plain", () => {
		const md = new Markdown("", 0, 0, DIFF_THEME);
		md.transientRenderCache = true;
		md.setText("```diff\n+added\n-removed\n+partial");
		const rows = md.render(WIDTH).map(row => stripVTControlCharacters(row).trim());

		expect(rows).toContain("HL:+added");
		expect(rows).toContain("HL:-removed");
		expect(rows).toContain("+partial");
		expect(rows).not.toContain("HL:+partial");
	});

	it("highlights its last line once the fence closes", () => {
		const md = new Markdown("", 0, 0, DIFF_THEME);
		md.transientRenderCache = true;
		md.setText("```diff\n+added\n+last\n```");
		const rows = md.render(WIDTH).map(row => stripVTControlCharacters(row).trim());

		expect(rows).toContain("HL:+added");
		expect(rows).toContain("HL:+last");
	});

	for (const chunk of [1, 6]) {
		it(`renders the rows a full render does while it grows ${chunk} characters at a time`, () => {
			expectFramesMatchColdRender(
				growthFrames("Intro.\n\n```diff\n", `${DIFF_BODY}\n\`\`\`\n\nAfter.`, chunk),
				UNIFORM_DIFF_THEME,
				{ style: BACKGROUND },
			);
		});
	}

	it("restyles the lines a fence in another language laid out first", () => {
		const body = "+a\n-b\n+c";
		for (const [first, second] of [
			["ts", "diff"],
			["diff", "patch"],
			["patch", "ts"],
		]) {
			const opened = `Intro.\n\n\`\`\`${first}\n${body}`;
			const md = new Markdown("", 2, 1, DIFF_THEME);
			md.transientRenderCache = true;
			for (const text of [opened, `${opened}\n\`\`\`\n\n\`\`\`${second}\n${body}`]) {
				md.setText(text);
				expect(md.render(WIDTH), `${first} then ${second}`).toEqual(renderFresh(text, WIDTH, DIFF_THEME));
			}
		}
	});
});

describe("streaming a fence line by line", () => {
	for (const lang of ["ts", "diff"]) {
		it(`lays out each complete ${lang} line once rather than once per frame`, () => {
			// Every laid-out row is filled with the background, so the fill count bounds the layout count.
			let backgroundFills = 0;
			const style: DefaultTextStyle = {
				bgColor: text => {
					backgroundFills++;
					return text;
				},
			};
			const lines = 400;
			const md = new Markdown("", 0, 0, DIFF_THEME, style);
			md.transientRenderCache = true;
			let text = `Intro.\n\n\`\`\`${lang}\n`;
			for (let i = 0; i < lines; i++) {
				text += `+line ${i}\n`;
				md.setText(text);
				md.render(WIDTH);
			}

			// A frame lays out the lines completed since the last frame, the line still streaming and
			// the two fence rows, plus the signature probe and the padding rows: a constant per frame.
			// Laying out the whole fence on every frame costs lines² / 2, which is 80,000 rows here.
			expect(backgroundFills).toBeLessThanOrEqual(10 * lines);
		});
	}
});
