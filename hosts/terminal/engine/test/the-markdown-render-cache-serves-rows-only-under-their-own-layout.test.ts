/**
 * The shared render cache serves a text's rows only under the layout they were drawn under.
 *
 * THE CLASS. The module-level cache hands a Markdown the rows another instance rendered for the same
 * text. The rows depend on the width, the padding, the code block indent, the theme and default style
 * objects, the terminal's capability flags, and what the theme's heading and the style's background
 * functions emit. Rows served under any other value of any of these are another layout's rows: the
 * wrong wrap, the wrong colours, OSC 8 links on a terminal without them. The cache is keyed by the text
 * alone and compares the rest on lookup, so a field the comparison skips is a stale row on screen.
 *
 * THE SWEEP. `VARIANTS` is a `Record` over every field of `RenderSignature`, so a field added to the
 * signature fails the type check until it has a variant here. Each variant renders the text in one
 * instance, changes that one input, and renders the text in a second instance: the second hands out
 * an array of its own, holding the rows a render under the changed input produces with the cache
 * empty. An equal layout in between is served the first array, so the cache is in use.
 *
 * WHAT IT DOES NOT CATCH. An input the rows depend on that is not a field of `RenderSignature`. For a
 * variant whose rows equal the base layout's (the image protocol, a copy of the theme or style
 * object), the sweep proves only that the cache misses.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	clearRenderCache,
	type DefaultTextStyle,
	Markdown,
	type MarkdownTheme,
	type RenderSignature,
} from "@veyyon/tui/components/markdown";
import {
	ImageProtocol,
	setTerminalImageProtocol,
	setTerminalTextSizing,
	TERMINAL,
} from "@veyyon/tui/terminal-capabilities";
import { defaultMarkdownTheme } from "./test-themes.js";

const TEXT = [
	"# Cached heading",
	"",
	"A paragraph long enough to wrap at the narrow width, with a [link](https://example.com) inside it,",
	"so the hyperlink capability changes the bytes of its row.",
	"",
	"```ts",
	"const cached = true;",
	"```",
].join("\n");

const BASE_HEADING_MARK = "#";
const BASE_BACKGROUND = "\x1b[44m";

/** What the theme's heading function prefixes; a variant changes it without a new theme object. */
let headingMark = BASE_HEADING_MARK;
/** What the style's background function opens with; a variant changes it without a new style object. */
let background = BASE_BACKGROUND;

const THEME: MarkdownTheme = { ...defaultMarkdownTheme, heading: text => `${headingMark}${text}` };
const STYLE: DefaultTextStyle = { bgColor: text => `${background}${text}\x1b[49m` };

interface Layout {
	width: number;
	paddingX: number;
	paddingY: number;
	codeBlockIndent: number;
	theme: MarkdownTheme;
	style: DefaultTextStyle;
}

const BASE: Layout = { width: 60, paddingX: 1, paddingY: 0, codeBlockIndent: 2, theme: THEME, style: STYLE };

type MutableCapabilities = { hyperlinks: boolean };
const capabilities = TERMINAL as unknown as MutableCapabilities;
const original = {
	imageProtocol: TERMINAL.imageProtocol,
	hyperlinks: TERMINAL.hyperlinks,
	textSizing: TERMINAL.textSizing,
};

/** One input changed from the base layout: a constructor argument, or state read at render time. */
interface Variant {
	layout?: Partial<Layout>;
	enter?: () => void;
}

const VARIANTS: Record<keyof RenderSignature, Variant> = {
	width: { layout: { width: 40 } },
	paddingX: { layout: { paddingX: 3 } },
	paddingY: { layout: { paddingY: 1 } },
	codeBlockIndent: { layout: { codeBlockIndent: 4 } },
	themeId: { layout: { theme: { ...THEME } } },
	defaultTextStyleId: { layout: { style: { ...STYLE } } },
	imageProtocol: {
		enter: () =>
			setTerminalImageProtocol(
				TERMINAL.imageProtocol === ImageProtocol.Kitty ? ImageProtocol.Sixel : ImageProtocol.Kitty,
			),
	},
	hyperlinks: {
		enter: () => {
			capabilities.hyperlinks = !capabilities.hyperlinks;
		},
	},
	textSizing: { enter: () => setTerminalTextSizing(!TERMINAL.textSizing) },
	bgColorProbe: {
		enter: () => {
			background = "\x1b[45m";
		},
	},
	headingProbe: {
		enter: () => {
			headingMark = "=";
		},
	},
};

function render(layout: Layout): readonly string[] {
	return new Markdown(TEXT, layout.paddingX, layout.paddingY, layout.theme, layout.style, layout.codeBlockIndent)
		.setIgnoreTight(true)
		.render(layout.width);
}

afterEach(() => {
	setTerminalImageProtocol(original.imageProtocol);
	capabilities.hyperlinks = original.hyperlinks;
	setTerminalTextSizing(original.textSizing);
	headingMark = BASE_HEADING_MARK;
	background = BASE_BACKGROUND;
	clearRenderCache();
});

describe("the markdown render cache serves rows only under their own layout", () => {
	it.each(Object.entries(VARIANTS))("%s: another value renders the rows of its own layout", (_field, variant) => {
		clearRenderCache();
		const first = render(BASE);
		expect(render(BASE)).toBe(first);

		variant.enter?.();
		const layout = { ...BASE, ...variant.layout };
		const served = render(layout);
		clearRenderCache();
		const cold = render(layout);

		expect(served).not.toBe(first);
		expect(served).toEqual(cold);
	});
});
