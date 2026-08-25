/**
 * `LOOKS_LIKE_TS` is a regex over the whole cell, not a tokeniser.
 *
 * WHY THIS SUITE EXISTS. `stripTypeScriptSyntax` only runs Bun's TS
 * transpiler when the heuristic matches. The comment above the regex claims
 * string literals using `as` are safe because of a word-boundary plus
 * colon/keyword neighbor. That does not hold for `type X =` appearing inside
 * comments or strings.
 *
 * Happy-path `const x: number` already lives in rewrite-imports.test.ts.
 * One comment token and one string token pin the heuristic; extra
 * interface/import-type/satisfies clones of the same regex fire are not
 * separate contracts.
 */
import { describe, expect, it } from "bun:test";
import { stripTypeScriptSyntax, wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("LOOKS_LIKE_TS must not fire on comments or strings", () => {
	it("leaves a JS cell whose only `type Foo =` sits in a line comment", () => {
		const code = "const x = 1; // type Foo = number\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `type Foo =` is inside a double-quoted string", () => {
		const code = 'const s = "type Foo = number";\n';
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only generic `<Foo>` is a comparison, not a type argument", () => {
		const code = "const ok = 1 < Foo && Foo > 0;\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("does not treat `as soon` as a type assertion (`as` requires const or a capitalized type)", () => {
		const code = "const msg = 'do this as soon as possible';\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});
});

describe("LOOKS_LIKE_TS still fires for real type syntax mixed with comments", () => {
	it("still strips a real annotation even when a comment also mentions types", () => {
		const code = "const x: number = 1; // type Foo = string\n";
		const out = stripTypeScriptSyntax(code);
		expect(out).not.toContain(": number");
		expect(out).toContain("const x = 1");
	});
});

describe("wrapCode does not TS-strip a JS cell that only mentions types in a string", () => {
	it("keeps the string contents and still demotes const to var", async () => {
		const code = 'const s = "type Foo = number";';
		const wrapped = await wrapCode(code);
		expect(wrapped.source).toContain('"type Foo = number"');
		expect(wrapped.source).toContain("var s");
		expect(wrapped.source).not.toContain("const s");
	});
});
