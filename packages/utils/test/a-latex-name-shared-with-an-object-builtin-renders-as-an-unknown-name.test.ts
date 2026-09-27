/**
 * Both LaTeX engines resolve command, environment, color and delimiter names
 * from model-authored text through lookup tables. A table built as an object
 * literal answers `constructor`, `toString`, `__proto__` and every other
 * `Object.prototype` member with an inherited function or object, so
 * `\toString{x}` threw, `\left\constructor` printed `function Object() {…}`,
 * `\constructor{a}{b}` stacked as a fraction and `\begin{__proto__}` wrapped its
 * body in `undefined`. The class this suite closes: a name that matches an
 * inherited member renders exactly as a name no table holds.
 *
 * The names come from `Object.getOwnPropertyNames(Object.prototype)` at run
 * time, so a member a runtime adds is covered without an edit here. Every name
 * renders in every position against a control name of the same length that no
 * table holds, so padded multi-line layouts compare byte for byte.
 *
 * Not caught: a lookup keyed by a composite (`style:char`, `num/den`) or by a
 * single code point, which no inherited member name can equal, so those tables
 * cannot regress into this defect.
 */
import { describe, expect, it } from "bun:test";
import { latexToBlock } from "@veyyon/utils/latex-block";
import { latexColorScope, latexToUnicode } from "@veyyon/utils/latex-unicode";

const INHERITED_NAMES: readonly string[] = Object.getOwnPropertyNames(Object.prototype);
/** Inherited names that can be a command name: `\` followed by ASCII letters only. */
const INHERITED_COMMAND_NAMES: readonly string[] = INHERITED_NAMES.filter(name => /^[A-Za-z]+$/.test(name));

/** Positions where a name is read as a command. */
const COMMAND_POSITIONS: readonly ((name: string) => string)[] = [
	name => `\\${name}`,
	name => `\\${name} x`,
	name => `\\${name}{x}{y}`,
	name => `\\${name}_{a}^{b} x`,
	name => `\\${name}\\limits_{a}^{b} x`,
	name => `\\${name}*{x}`,
	name => `\\left\\${name} x \\right.`,
	name => `\\left( x \\right\\${name}`,
	name => `\\left\\${name} \\frac{a}{b} \\right.`,
	name => `\\bigl\\${name} x`,
];

/** Positions where a name is read as raw text: an environment or a color. */
const TEXT_POSITIONS: readonly ((name: string) => string)[] = [
	name => `\\begin{${name}}a&b\\\\c&d\\end{${name}}`,
	name => `\\begin{${name}}\\frac{a}{b}\\end{${name}}`,
	name => `\\begin{${name}*}\\frac{a}{b}\\end{${name}*}`,
	name => `\\textcolor{${name}}{x}`,
	name => `\\textcolor[named]{${name}}{x}`,
	name => `\\textcolor{${name}!50!white}{x}`,
	name => `\\colorbox{${name}}{x}`,
	name => `\\fcolorbox{${name}}{${name}}{x}`,
	name => `{\\color{${name}} x} y`,
];

const ENGINES: readonly { label: string; render: (src: string) => string }[] = [
	{ label: "latexToUnicode", render: latexToUnicode },
	{ label: "latexToBlock", render: src => latexToBlock(src).join("\n") },
];

/** A name of the same length that no table holds. */
function controlFor(name: string): string {
	return "q".repeat(name.length);
}

function expectRendersAsUnknown(
	render: (src: string) => string,
	position: (name: string) => string,
	name: string,
): void {
	const control = controlFor(name);
	expect(render(position(name))).toBe(render(position(control)).replaceAll(control, name));
}

describe("a LaTeX name shared with an Object builtin", () => {
	it("enumerates inherited names that can reach both command and text positions", () => {
		expect(INHERITED_COMMAND_NAMES).toContain("constructor");
		expect(INHERITED_NAMES).toContain("__proto__");
	});

	for (const { label, render } of ENGINES) {
		it(`renders as an unknown command in every command position (${label})`, () => {
			for (const position of COMMAND_POSITIONS) {
				for (const name of INHERITED_COMMAND_NAMES) expectRendersAsUnknown(render, position, name);
			}
		});

		it(`renders as an unknown environment or color in every text position (${label})`, () => {
			for (const position of TEXT_POSITIONS) {
				for (const name of INHERITED_NAMES) expectRendersAsUnknown(render, position, name);
			}
		});
	}

	it("negates with the combining solidus rather than an inherited glyph", () => {
		for (const name of INHERITED_COMMAND_NAMES) {
			expect(latexToUnicode(`\\not{${name}}`)).toBe([...name].map(ch => `${ch}\u0338`).join(""));
		}
	});

	it("resolves to no color scope", () => {
		for (const name of INHERITED_NAMES) {
			expect(latexColorScope(null, name)).toBeNull();
			expect(latexColorScope("named", name)).toBeNull();
		}
	});
});
