/**
 * WHY: `colorMode: "html"` output is inserted into a page as markup. The defect class is a character
 * the renderer did not write as markup reaching that markup raw: diagram text in a text node, or a
 * theme color in the `style` attribute of a color span. `escapeHtml` escaped `&`, `<` and `>` only,
 * so a quote in an attribute value ended the attribute; the xychart row colorizer also emitted
 * uncolored text with no escaping at all.
 *
 * The suite renders every golden fixture and one hostile fixture per diagram kind, with the default
 * theme and with every theme key (enumerated from `DEFAULT_ASCII_THEME` at run time) set to a value
 * that breaks out of the attribute and to an empty color. It asserts that the HTML output is color
 * spans around escaped text and nothing else, and that decoding it reproduces the `none` output
 * character for character, so a dropped, doubled or unescaped character fails. No renderer leaves a
 * drawn character without a role, so the uncolored branch of `colorizeLine` is driven directly.
 *
 * Not caught: a diagram kind with no hostile fixture below, since the kind dispatch in the vendored
 * renderer is not exported for a sweep, and a theme key declared on `AsciiTheme` but absent from
 * `DEFAULT_ASCII_THEME` (`accent`, `bg`), which the sweep does not set.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { colorizeLine, DEFAULT_ASCII_THEME, escapeHtml } from "../../src/vendor/mermaid-ascii/ascii/ansi";
import { renderMermaidAscii } from "../../src/vendor/mermaid-ascii/ascii/index";
import type { AsciiTheme, CharRole } from "../../src/vendor/mermaid-ascii/ascii/types";

const HOSTILE_TEXT = `it's <b> & "q" &amp;`;
const HOSTILE_COLOR = `#fff" onmouseover="alert('x')`;

const HOSTILE_FIXTURES: Record<string, string> = {
	flowchart: `graph LR\n  A[${HOSTILE_TEXT}] --> B[x > y & z]`,
	sequence: `sequenceDiagram\n  Alice->>Bob: ${HOSTILE_TEXT}`,
	class: `classDiagram\n  class Animal {\n    +name ${HOSTILE_TEXT}\n  }`,
	er: `erDiagram\n  CUSTOMER ||--o{ ORDER : "it's <b> & q"`,
	xychart: `xychart-beta\n  title "${HOSTILE_TEXT.replaceAll('"', "'")}"\n  x-axis ["a<b", "c&d", "e'f"]\n  y-axis "v'x" 0 --> 10\n  bar [3, 5, 7]`,
};

const TESTDATA = join(import.meta.dirname, "testdata");
const PADDING_DIRECTIVE = /^\s*padding[xy]\s*=\s*\d+\s*$/i;

interface Fixture {
	name: string;
	source: string;
	useAscii: boolean;
}

const goldenFixtures: Fixture[] = readdirSync(TESTDATA)
	.sort()
	.flatMap(dir =>
		readdirSync(join(TESTDATA, dir))
			.filter(file => file.endsWith(".txt"))
			.sort()
			.map(file => {
				const content = readFileSync(join(TESTDATA, dir, file), "utf-8");
				const source = content
					.slice(0, content.indexOf("\n---\n"))
					.split("\n")
					.filter(line => !PADDING_DIRECTIVE.test(line))
					.join("\n");
				return { name: `${dir}/${file}`, source, useAscii: dir === "ascii" };
			}),
	);

const hostileFixtures: Fixture[] = Object.entries(HOSTILE_FIXTURES).map(([kind, source]) => ({
	name: `hostile ${kind}`,
	source,
	useAscii: false,
}));

/** Default theme, then every theme key set to an attribute breakout and to an empty color. */
const themes: { name: string; theme: Partial<AsciiTheme> }[] = [
	{ name: "default theme", theme: {} },
	...Object.keys(DEFAULT_ASCII_THEME).flatMap(key => [
		{ name: `${key}=hostile`, theme: { [key]: HOSTILE_COLOR } },
		{ name: `${key}=empty`, theme: { [key]: "" } },
	]),
];

const COLOR_SPAN = /<span style="color:([^"<>]*)">([^<]*)<\/span>/g;
/** A raw markup character, or an `&` that does not begin one of the entities `escapeHtml` writes. */
const UNESCAPED = /[<>"']|&(?!(?:amp|lt|gt|quot|#39);)/;
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** Assert `html` is color spans around escaped text, and return the text it displays. */
function displayedText(html: string): string {
	const colors: string[] = [];
	const text = html.replace(COLOR_SPAN, (_span, color: string, body: string) => {
		colors.push(color);
		return body;
	});
	for (const color of colors) expect(color).not.toMatch(UNESCAPED);
	expect(text).not.toMatch(UNESCAPED);
	return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!);
}

function assertEscapedRoundTrip(fixture: Fixture, theme: Partial<AsciiTheme>): void {
	const options = { useAscii: fixture.useAscii, theme };
	const plain = renderMermaidAscii(fixture.source, { ...options, colorMode: "none" });
	const html = renderMermaidAscii(fixture.source, { ...options, colorMode: "html" });
	expect(displayedText(html)).toBe(plain);
}

describe("escapeHtml", () => {
	it("escapes every character that ends a text node or a quoted attribute value", () => {
		expect(escapeHtml(`a&<>"'b &amp;`)).toBe("a&amp;&lt;&gt;&quot;&#39;b &amp;amp;");
	});
});

describe("html color mode", () => {
	it("sweeps at least one golden fixture per testdata directory", () => {
		expect(new Set(goldenFixtures.map(f => f.name.split("/")[0]))).toEqual(new Set(readdirSync(TESTDATA)));
	});

	for (const fixture of goldenFixtures) {
		it(`${fixture.name} decodes to the plain rendering`, () => {
			assertEscapedRoundTrip(fixture, {});
		});
	}

	for (const fixture of hostileFixtures) {
		for (const { name, theme } of themes) {
			it(`${fixture.name} with ${name} decodes to the plain rendering`, () => {
				assertEscapedRoundTrip(fixture, theme);
			});
		}
	}

	it("writes a hostile theme color into the style attribute escaped, not dropped", () => {
		const html = renderMermaidAscii(HOSTILE_FIXTURES.flowchart!, { colorMode: "html", theme: { fg: HOSTILE_COLOR } });
		expect(html).toContain(`<span style="color:${escapeHtml(HOSTILE_COLOR)}">`);
	});

	it("escapes a row whose characters have no role", () => {
		const chars = [...HOSTILE_TEXT];
		const roles: (CharRole | null)[] = chars.map((_, i) => (i % 3 === 0 ? "text" : null));
		expect(displayedText(colorizeLine(chars, roles, DEFAULT_ASCII_THEME, "html"))).toBe(HOSTILE_TEXT);
	});
});
