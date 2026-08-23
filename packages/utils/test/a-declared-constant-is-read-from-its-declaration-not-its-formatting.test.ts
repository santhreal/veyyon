import { describe, expect, it } from "bun:test";
import { declarersOfStringValue, stringConstantsIn, stringConstantValue } from "../src/source-declarations";

/**
 * WHY: one-owner gates across this repo proved "the value is declared here and nowhere else" by searching
 * source text for a formatted line -- `expect(text).toContain('export const CODE_FENCE = "```";')`. That
 * assertion is wrong in both directions. It goes red on a rename, a reflow, or a quote-style change that
 * breaks nothing, and it stays GREEN when a second module declares the identical value under another name,
 * with different spacing, or in single quotes, which is the whole defect class those gates exist to catch.
 *
 * The class this closes: a duplicate constant that the text scan cannot see. The census reads declarations
 * and compares decoded VALUES, so quote style, spacing, a type annotation, `as const`, and the binding name
 * are all invisible to it, and a duplicate is red however it is spelled.
 *
 * What it does not catch, and deliberately: a value built by concatenation or interpolation, one assembled
 * at run time, one inside an object or array literal, and one bound with `let` or `var`. Those need a real
 * parse of the module. The cases below pin that boundary so a caller cannot mistake silence for absence.
 */

describe("a declared string constant is read from its declaration", () => {
	it("reports the name, the decoded value, and whether it is exported", () => {
		const source = ['export const OPEN = "```";', 'const PRIVATE = "x";'].join("\n");

		expect(stringConstantsIn(source)).toEqual([
			{ name: "OPEN", value: "```", exported: true },
			{ name: "PRIVATE", value: "x", exported: false },
		]);
	});

	it("reads the three quote styles as one value", () => {
		const source = ['const A = "v";', "const B = 'v';", "const C = `v`;"].join("\n");

		expect(stringConstantsIn(source).map(constant => constant.value)).toEqual(["v", "v", "v"]);
	});

	it("tolerates a type annotation, `as const`, and spacing a formatter chooses", () => {
		const source = ['const A: string = "v";', '\tconst B  =   "v" as const;', 'export const C = "v";'].join("\n");

		expect(stringConstantsIn(source).map(constant => constant.name)).toEqual(["A", "B", "C"]);
	});

	/** The escapes a wire tag really carries: a fence with newlines, a control character, a code point. */
	it("resolves escapes so the value is the characters, not the source bytes", () => {
		const source = [
			'const FENCE = "```thinking\\n";',
			'const TAB = "a\\tb";',
			'const HEX = "\\x41";',
			'const UNI = "\\u007c";',
			'const BIG = "\\u{1f600}";',
			'const QUOTED = "say \\"hi\\"";',
			'const BACKSLASH = "a\\\\b";',
		].join("\n");

		expect(stringConstantsIn(source).map(constant => constant.value)).toEqual([
			"```thinking\n",
			"a\tb",
			"A",
			"|",
			"\u{1f600}",
			'say "hi"',
			"a\\b",
		]);
	});

	/** An unescaped closing quote inside the literal is where a naive reader splits one value into two. */
	it("keeps an escaped quote inside the literal rather than ending it", () => {
		expect(stringConstantsIn('const A = "a\\"b";')).toEqual([{ name: "A", value: 'a"b', exported: false }]);
	});

	/** The same reason `withoutComments` exists next door: prose about a declaration is not a declaration. */
	it("does not count a declaration quoted in a comment", () => {
		const source = ['// const GHOST = "v";', '/* const ALSO_GHOST = "v"; */', 'const REAL = "v";'].join("\n");

		expect(stringConstantsIn(source).map(constant => constant.name)).toEqual(["REAL"]);
	});

	it("ignores an interpolated template, a `let`, and a non-string initializer", () => {
		const source = [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the `${x}` is the fixture -- an
			// interpolated template the census must refuse to report as a constant.
			"const INTERPOLATED = `a${x}b`;",
			'let MUTABLE = "v";',
			"const NUMBER = 3;",
			'const OBJECT = { path: "/callback" };',
		].join("\n");

		expect(stringConstantsIn(source)).toEqual([]);
	});
});

describe("the census of who declares a value", () => {
	const owner = { file: "owner.ts", source: 'export const DEFAULT_CALLBACK_PATH = "/callback";' };
	const importer = { file: "importer.ts", source: 'import { DEFAULT_CALLBACK_PATH } from "./owner";' };

	it("names the owner alone when nobody else declares it", () => {
		expect(declarersOfStringValue([owner, importer], "/callback")).toEqual(["owner.ts"]);
	});

	/**
	 * The reason this exists. Each of these duplicates satisfies `not.toContain('export const
	 * DEFAULT_CALLBACK_PATH = "/callback";')` and every one of them is the bug.
	 */
	it.each([
		["a different binding name", 'const CALLBACK_PATH = "/callback";'],
		["single quotes", "const CALLBACK_PATH = '/callback';"],
		["a template literal", "const CALLBACK_PATH = `/callback`;"],
		["extra spacing", 'const CALLBACK_PATH   =    "/callback";'],
		["a type annotation", 'const CALLBACK_PATH: string = "/callback";'],
	])("catches a second declarer that uses %s", (_why, line) => {
		expect(declarersOfStringValue([owner, { file: "second.ts", source: line }], "/callback")).toEqual([
			"owner.ts",
			"second.ts",
		]);
	});

	it("reads a module-private constant by name for a gate that cannot import it", () => {
		expect(stringConstantValue('const CALLBACK_PATH = "/auth/callback";', "CALLBACK_PATH")).toBe("/auth/callback");
		expect(stringConstantValue('const OTHER = "x";', "CALLBACK_PATH")).toBeUndefined();
	});
});
