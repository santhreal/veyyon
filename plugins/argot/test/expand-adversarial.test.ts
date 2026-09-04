/**
 * Adversarial, hand-written edge cases for the expander, complementing the
 * seeded fuzz in property.test.ts. These pin the behaviors most likely to break
 * under a naive implementation: a sigil that is a RegExp metacharacter (so
 * escapeRegExp must fire), an expansion that looks like a RegExp replacement
 * pattern (`$&`, `$1` must be inserted literally), the exact boundary rule, and
 * structural oddities (empty input, lone sigils, multiline, unicode, scale).
 */

import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import type { Vocabulary } from "../src/types.js";

/** Build a vocabulary directly, bypassing TOML, to fuzz the codec in isolation. */
function vocab(sigil: string, handles: Record<string, string>): Vocabulary {
	return { version: 1, sigil, handles: new Map(Object.entries(handles)), meta: new Map() };
}

describe("expand with RegExp-metacharacter sigils", () => {
	// Each of these sigils is a RegExp metacharacter; escapeRegExp must neutralize
	// it or the compiled pattern would match the wrong thing (or throw).
	const METACHAR_SIGILS = ["$", ".", "*", "+", "?", "^", "|", "(", ")", "[", "]", "\\", "@@", "#$"];

	for (const sigil of METACHAR_SIGILS) {
		test(`sigil ${JSON.stringify(sigil)} expands its handle and nothing else`, () => {
			const expand = makeExpander(vocab(sigil, { db: "the/database" }));
			expect(expand(`open ${sigil}db now`)).toBe("open the/database now");
			// A bare instance of the sigil with no known name is left untouched.
			expect(expand(`just ${sigil} alone`)).toBe(`just ${sigil} alone`);
			// The default § must not fire under a custom sigil.
			expect(expand("§db")).toBe("§db");
		});
	}

	test("a backslash sigil does not corrupt the compiled pattern", () => {
		const expand = makeExpander(vocab("\\", { p: "x/y" }));
		expect(expand("path \\p end")).toBe("path x/y end");
	});
});

describe("expand with replacement-pattern expansions", () => {
	// `String.replace` treats `$&`, `$1`, `$$` specially in a string replacement.
	// The codec must use a function replacer so these land verbatim.
	test("an expansion containing $& is inserted literally, not the matched text", () => {
		const expand = makeExpander(vocab("§", { m: "cost is $&x" }));
		expect(expand("§m")).toBe("cost is $&x");
	});

	test("an expansion containing $1 and $$ is inserted literally", () => {
		const expand = makeExpander(vocab("§", { p: "$1 off, pay in $$" }));
		expect(expand("§p")).toBe("$1 off, pay in $$");
	});

	test("an expansion that looks like a group reference survives", () => {
		const expand = makeExpander(vocab("§", { g: "use $<name> here" }));
		expect(expand("§g")).toBe("use $<name> here");
	});
});

describe("expand boundary rule", () => {
	const expand = makeExpander(vocab("§", { db: "DATABASE", dbconn: "CONN" }));

	test("expands before whitespace, punctuation, and end of string", () => {
		expect(expand("§db ")).toBe("DATABASE ");
		expect(expand("§db.")).toBe("DATABASE.");
		expect(expand("§db-x")).toBe("DATABASE-x");
		expect(expand("§db")).toBe("DATABASE");
	});

	test("expands before an uppercase letter, which is outside the name class", () => {
		// The boundary guard is [a-z0-9_]; uppercase is not a name character.
		expect(expand("§dbX")).toBe("DATABASEX");
	});

	test("does not expand when a lowercase letter, digit, or underscore follows", () => {
		expect(expand("§dbx")).toBe("§dbx");
		expect(expand("§db9")).toBe("§db9");
		expect(expand("§db_")).toBe("§db_");
	});

	test("prefers the longest handle at a shared prefix", () => {
		expect(expand("§dbconn")).toBe("CONN");
		expect(expand("§db")).toBe("DATABASE");
	});
});

describe("expand structural edge cases", () => {
	const expand = makeExpander(vocab("§", { a: "AAA", ab: "ABAB", abc: "ABCABC" }));

	test("the empty string maps to the empty string", () => {
		expect(expand("")).toBe("");
	});

	test("a lone sigil and a sigil at end of input are untouched", () => {
		expect(expand("§")).toBe("§");
		expect(expand("trailing §")).toBe("trailing §");
		expect(expand("§§§")).toBe("§§§");
	});

	test("a doubled sigil expands only the well-formed second handle", () => {
		// §§a: the first § has no name after it (the next char is §), the second does.
		expect(expand("§§a")).toBe("§AAA");
	});

	test("overlapping-prefix handles each expand at their own boundary", () => {
		expect(expand("§abc §ab §a")).toBe("ABCABC ABAB AAA");
	});

	test("expands across newlines and preserves them", () => {
		expect(expand("line §a\nline §ab\n")).toBe("line AAA\nline ABAB\n");
	});

	test("preserves surrounding unicode and expands normally", () => {
		const expand2 = makeExpander(vocab("§", { p: "packages/x" }));
		expect(expand2("café → §p ✅")).toBe("café → packages/x ✅");
	});

	test("an unknown handle between known ones is passed through", () => {
		expect(expand("§a §zzz §ab")).toBe("AAA §zzz ABAB");
	});
});

describe("expand at scale", () => {
	test("expands a thousand interleaved handles correctly", () => {
		const expand = makeExpander(vocab("§", { h: "EXPANDED", x: "OTHER" }));
		const input = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? "§h" : "§x")).join(" ");
		const out = expand(input);
		expect(out).not.toContain("§");
		expect(out.split("EXPANDED").length - 1).toBe(500);
		expect(out.split("OTHER").length - 1).toBe(500);
	});

	test("a large handle table resolves the right expansion for each", () => {
		const handles: Record<string, string> = {};
		for (let i = 0; i < 300; i++) handles[`h${i}`] = `EXPANSION_${i}`;
		const expand = makeExpander(vocab("§", handles));
		expect(expand("§h0 §h150 §h299")).toBe("EXPANSION_0 EXPANSION_150 EXPANSION_299");
		// §h29 must not be shadowed by §h299 or vice versa (longest-first + boundary).
		expect(expand("§h29 done")).toBe("EXPANSION_29 done");
	});
});
