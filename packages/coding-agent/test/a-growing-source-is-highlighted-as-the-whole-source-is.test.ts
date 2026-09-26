/**
 * WHY: a card that streams a file redraws on every argument delta, and `highlightCode` continues the
 * highlighter from where the source it drew last left off instead of highlighting the whole file
 * again. The defect class is a continued highlight that differs from a whole one: a token colour
 * that runs through a line end and resets on the next row, a construct opened on one line and closed
 * on a later one, a blank line after a coloured one, two sources streaming at once, the same text in
 * two languages, a source that changed behind the part already highlighted, and a theme switch in
 * the middle of a stream. Every frame is compared with the native highlighter run over the whole
 * frame from scratch.
 *
 * Not caught: the cost. A continuation that silently re-highlights the whole source on every frame is
 * byte-identical and passes here; the bound is measured by the streaming-card bench.
 */
import { describe, expect, it } from "bun:test";
import { highlightCode } from "@veyyon/coding-agent/theme/highlight";
import { getThemeByName, type Theme } from "@veyyon/coding-agent/theme/theme";
import { highlightCode as nativeHighlightCode, supportsLanguage } from "@veyyon/natives";

/** Sources that open a construct on one line and close it on a later one. */
const SOURCES: ReadonlyArray<{ lang: string | undefined; source: string }> = [
	{
		lang: "ts",
		source:
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the `${name}` is a template literal in the TypeScript source the highlighter colours
			"// lead comment\n\n/* a block\n   comment */\nconst greeting = `hello\n${name}`;\nfunction f(x: number) {\n\treturn x * 2; // done\n}\n",
	},
	{ lang: "python", source: 'def f():\n    """A docstring\n    across lines"""\n    return \'x\'  # tail\n\n' },
	{ lang: "rust", source: 'fn main() {\n    let s = r#"raw\nline"#;\n    /* outer /* inner */\n still */\n}\n' },
	{ lang: "diff", source: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n" },
	{ lang: undefined, source: "plain text\nwith no language\n" },
];

function colorsOf(theme: Theme) {
	return {
		comment: theme.getFgAnsi("syntaxComment"),
		keyword: theme.getFgAnsi("syntaxKeyword"),
		function: theme.getFgAnsi("syntaxFunction"),
		variable: theme.getFgAnsi("syntaxVariable"),
		string: theme.getFgAnsi("syntaxString"),
		number: theme.getFgAnsi("syntaxNumber"),
		type: theme.getFgAnsi("syntaxType"),
		operator: theme.getFgAnsi("syntaxOperator"),
		punctuation: theme.getFgAnsi("syntaxPunctuation"),
		inserted: theme.getFgAnsi("toolDiffAdded"),
		deleted: theme.getFgAnsi("toolDiffRemoved"),
	};
}

/** The rows the native highlighter draws for the whole of `code`, with nothing carried over. */
function wholeRows(code: string, lang: string | undefined, theme: Theme): string[] {
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	return nativeHighlightCode(code, validLang, colorsOf(theme)).split("\n");
}

/** Every prefix of `source`, one character longer each time, as a stream delivers it. */
function prefixes(source: string): string[] {
	return Array.from({ length: source.length }, (_, index) => source.slice(0, index + 1));
}

async function loadTheme(name: string): Promise<Theme> {
	const theme = await getThemeByName(name);
	if (theme === undefined) throw new Error(`theme ${name} is not bundled`);
	return theme;
}

describe("a source highlighted as it grows", () => {
	it("draws every frame as the whole frame is drawn", async () => {
		const theme = await loadTheme("dark");
		for (const { lang, source } of SOURCES) {
			for (const frame of prefixes(source)) {
				const rows = highlightCode(frame, lang, theme);
				expect({ lang, frame, rows }).toEqual({ lang, frame, rows: wholeRows(frame, lang, theme) });
				// A caller may add rows to what it was given, and the next frame must not see them.
				rows.push("appended by the caller");
			}
		}
	});

	it("keeps two sources streaming at once apart", async () => {
		const theme = await loadTheme("dark");
		const [first, second] = [SOURCES[0], SOURCES[1]];
		const firstFrames = prefixes(first.source);
		const secondFrames = prefixes(second.source);
		for (let index = 0; index < Math.max(firstFrames.length, secondFrames.length); index++) {
			for (const [{ lang }, frames] of [
				[first, firstFrames],
				[second, secondFrames],
			] as const) {
				const frame = frames[Math.min(index, frames.length - 1)];
				expect(highlightCode(frame, lang, theme)).toEqual(wholeRows(frame, lang, theme));
			}
		}
	});

	it("draws the same text in two languages in each language's colours", async () => {
		const theme = await loadTheme("dark");
		const source = "# heading or comment\nlet x = 'value'\n";
		for (const frame of prefixes(source)) {
			for (const lang of ["python", "ts"]) {
				expect({ lang, rows: highlightCode(frame, lang, theme) }).toEqual({
					lang,
					rows: wholeRows(frame, lang, theme),
				});
			}
		}
	});

	it("draws a source that changed behind the highlighted part as the new source", async () => {
		const theme = await loadTheme("dark");
		const { lang, source } = SOURCES[0];
		for (const frame of prefixes(source)) highlightCode(frame, lang, theme);
		const rewritten = `/* an earlier line changed */\n${source.slice(source.indexOf("\n") + 1)}`;
		const truncated = source.slice(0, source.indexOf("function"));
		for (const frame of [rewritten, truncated, `${truncated}let tail = 1;\n`]) {
			expect(highlightCode(frame, lang, theme)).toEqual(wholeRows(frame, lang, theme));
		}
	});

	it("draws the rest of a stream in the theme it switched to", async () => {
		const dark = await loadTheme("dark");
		const light = await loadTheme("light");
		const { lang, source } = SOURCES[0];
		const frames = prefixes(source);
		const switchAt = Math.floor(frames.length / 2);
		expect(wholeRows(source, lang, light)).not.toEqual(wholeRows(source, lang, dark));
		frames.forEach((frame, index) => {
			const theme = index < switchAt ? dark : light;
			expect(highlightCode(frame, lang, theme)).toEqual(wholeRows(frame, lang, theme));
		});
	});
});
