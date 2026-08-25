/**
 * `LOOKS_LIKE_TS` is a regex over the whole cell, not a tokeniser.
 *
 * WHY THIS SUITE EXISTS. `stripTypeScriptSyntax` only runs Bun's TS
 * transpiler when the heuristic matches. The comment above the regex claims
 * string literals using `as` are safe because of a word-boundary plus
 * colon/keyword neighbor. That does not hold for `type X =`, `interface X`,
 * `import type`, or `: string` appearing inside comments, JSDoc, or strings.
 *
 * Running the transpiler on plain JS is not free: a cell that happens to
 * contain those tokens in a comment can be rewritten (ASI, JSX, `as const`
 * in a string) or, on transpile failure, passed through unchanged. The
 * operator-facing contract is: a JavaScript cell whose only TS-shaped tokens
 * live in comments or strings MUST byte-identical after strip.
 *
 * The heuristic currently fires on those cells. These tests assert the
 * product contract (do not strip) and stay red until the heuristic is
 * comment/string-aware. Happy-path `const x: number` already lives in
 * rewrite-imports.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { stripTypeScriptSyntax, wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("LOOKS_LIKE_TS must not fire on comments", () => {
	it("leaves a JS cell whose only `type Foo =` sits in a line comment", () => {
		const code = "const x = 1; // type Foo = number\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `interface Foo` sits in a block comment", () => {
		const code = "const x = 1; /* interface Foo { a: string } */\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `import type` sits in JSDoc", () => {
		const code = "/** import type { Foo } from 'x' */\nconst x = 1;\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `: string` annotation sits in a comment", () => {
		const code = "// const name: string = 'x'\nconst name = 'x';\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `as const` sits in a comment", () => {
		const code = "const n = 1; // keep as const for the reader\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `satisfies` sits in a comment", () => {
		const code = "const n = 1; // satisfies Foo if we ever add types\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});
});

describe("LOOKS_LIKE_TS must not fire on string literals", () => {
	it("leaves a JS cell whose only `type Foo =` is inside a double-quoted string", () => {
		const code = 'const s = "type Foo = number";\n';
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `interface Foo` is inside a template literal", () => {
		const code = "const s = `interface Foo { x: number }`;\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `: string` is inside a single-quoted string", () => {
		const code = "const s = ': string';\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});

	it("leaves a JS cell whose only `as const` is inside a string", () => {
		const code = 'const s = "export const modes = [\'a\'] as const";\n';
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
