/**
 * wrapCode is the eval-cell preprocessor: capture a trailing expression, strip
 * TypeScript, rewrite imports, and — only when the cell itself awaits or
 * returns at the top level — wrap the source in an async IIFE so the worker
 * can wait it out. Nested functions are an execution boundary. A `return`
 * or `await` inside one of them must not force the wrapper, because wrapping
 * would then publish every top-level binding onto globalThis (publishGlobals)
 * and rewrite the cell's trailing expression through a different path.
 *
 * Top-level `return 7;` is the opposite mistake: without a rewrite it is
 * swallowed by the wrapper (the IIFE's return is discarded). returnFinalExpression
 * turns it into __veyyon_set_final_expr__((7)).
 *
 * Class declarations at the top level are demoted to `var Name = class ...`
 * so the next cell can see them. A class inside a function is left alone.
 */
import { describe, expect, it } from "bun:test";
import { wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("wrapCode does not wrap a cell whose only return/await is nested", () => {
	it("leaves a function that returns, plus a trailing call, unwrapped", async () => {
		const result = await wrapCode("function inner() { return 1; }\ninner");
		expect(result.asyncWrapped).toBe(false);
		expect(result.finalExpressionReturned).toBe(true);
		expect(result.source).toContain("__veyyon_set_final_expr__((inner))");
		expect(result.source).toContain("function inner() { return 1; }");
		expect(result.source.startsWith("(async () => {")).toBe(false);
	});

	it("does not wrap an async function declaration whose body awaits", async () => {
		const result = await wrapCode("async function f() { return await 1; }\nf()");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("async function f()");
		expect(result.source).toContain("return await 1");
	});

	it("does wrap a cell with a top-level await, and still captures the trailing expression", async () => {
		const result = await wrapCode("const x = await 1;\nx");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source.startsWith("(async () => {")).toBe(true);
		expect(result.source).toContain("var x = await 1");
		expect(result.source).toContain("__veyyon_set_final_expr__((x))");
	});

	it("rewrites a top-level return into the final-expression setter rather than swallowing it", async () => {
		const result = await wrapCode("return 7;");
		expect(result.finalExpressionReturned).toBe(true);
		expect(result.source).toContain("__veyyon_set_final_expr__((7))");
		expect(result.source).not.toContain("return 7");
	});

	it("wraps for-await-of at the top level, not a for-of", async () => {
		const awaited = await wrapCode("for await (const x of xs) x;");
		expect(awaited.asyncWrapped).toBe(true);
		const plain = await wrapCode("for (const x of xs) x;");
		expect(plain.asyncWrapped).toBe(false);
	});
});

describe("wrapCode demotes only top-level lexicals", () => {
	it("turns a top-level class into var Name = class, keeping extends", async () => {
		const result = await wrapCode("class Foo extends Bar {}");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toBe("var Foo = class extends Bar {};");
	});

	it("does not demote a class nested in a function", async () => {
		const result = await wrapCode("function make() { class Foo {} return Foo; }");
		expect(result.source).toContain("function make() { class Foo {} return Foo; }");
		expect(result.source).not.toContain("var Foo");
	});

	it("does not demote a const inside a function, only the top-level one", async () => {
		const result = await wrapCode("const a = 1;\nfunction f() { const b = 2; }");
		expect(result.source).toContain("var a = 1");
		expect(result.source).toContain("function f() { const b = 2; }");
	});
});
