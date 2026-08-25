/**
 * wrapCode's async decision is AST-driven, but several neighboring rewrites
 * run in an order that is easy to get wrong, and the wrapper has a second
 * job besides awaiting: publish every top-level binding onto this (the
 * worker global) because var/function inside the IIFE would otherwise die
 * with the cell.
 *
 * Order in wrapCode:
 *   1. returnFinalExpression (trailing expr / top-level return → __veyyon_set_final_expr__)
 *   2. stripTypeScript (LOOKS_LIKE_TS is a regex on the raw source, not an AST)
 *   3. rewriteImports (static import → await __veyyon_import__, which itself
 *      forces the async wrapper because the await is now at program body)
 *   4. requiresAsyncWrapper / containsAsyncWrapperSyntax (ReturnStatement,
 *      AwaitExpression, for-await; stops at function/method boundaries)
 *   5. demoteTopLevelLexicals({ publishGlobals: needsAsyncWrapper })
 *
 * Gaps this file pins:
 * - A top-level bare `return;` is a ReturnStatement so it wraps, but
 *   returnFinalExpression refuses to rewrite a return with no argument, so
 *   the IIFE swallows it. That is a rewrite hole, not a feature.
 * - containsAsyncWrapperSyntax skips comment nodes, so a comment that
 *   mentions await must not wrap. LOOKS_LIKE_TS does NOT skip strings, so
 *   `"as const"` can force the TS transpiler; the cell must still evaluate
 *   as the same string and must not wrap.
 * - When a cell wraps, destructuring (including rename and rest) and
 *   function declarations must be published as this["name"] = name, using
 *   the BINDING names, not the pattern keys.
 * - Class field initializers are not an execution boundary (only ClassMethod
 *   is). An await in a field is a SyntaxError in JS; errorRecovery still
 *   produces an AwaitExpression and must not be treated as a silent wrap of
 *   an otherwise-valid cell. We pin that the wrapper decision follows the
 *   recovered AST, and that a method-body await does not.
 */
import { describe, expect, it } from "bun:test";
import { wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("top-level bare return is not a reason to wrap-and-discard", () => {
	it("does not wrap a cell that is only return;", async () => {
		const result = await wrapCode("return;");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toBe("return;");
	});
});

describe("await in comments and strings is not an AwaitExpression", () => {
	it("does not wrap a cell whose only await is in a line comment", async () => {
		const result = await wrapCode("const x = 1; // await foo()");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).not.toContain("(async () =>");
	});

	it("does not wrap a cell whose only await is in a string", async () => {
		const result = await wrapCode('const s = "await foo()";');
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain('"await foo()"');
	});
});

describe("LOOKS_LIKE_TS matching inside a string must not change the string", () => {
	it("keeps the characters as const inside quotes, and does not wrap", async () => {
		const result = await wrapCode('const s = "as const";');
		expect(result.source).toContain('"as const"');
		expect(result.asyncWrapped).toBe(false);
	});
});

describe("publishGlobals writes the binding names, not the pattern keys", () => {
	it("publishes a renamed destructure and a rest binding when the cell awaits", async () => {
		const result = await wrapCode("const { a: b, ...rest } = await load();");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain('this["b"] = b;');
		expect(result.source).toContain('this["rest"] = rest;');
		expect(result.source).not.toContain('this["a"] = a;');
	});

	it("publishes a function declaration that would otherwise be scoped to the IIFE", async () => {
		const result = await wrapCode("function helper() { return 1; }\nawait helper();");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain('this["helper"] = helper;');
	});
});

describe("execution boundaries stop at methods, not at the class declaration", () => {
	it("does not wrap a class whose only await is inside a method", async () => {
		const src = [
			"class Worker {",
			"  async run() {",
			"    return await this.step();",
			"  }",
			"}",
		].join("\n");
		const result = await wrapCode(src);
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("var Worker = class");
	});
});
