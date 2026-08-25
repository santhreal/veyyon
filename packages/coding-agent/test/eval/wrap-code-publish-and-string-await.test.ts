/**
 * js-static-import-rewrite already publishes function declarations from
 * async-wrapped cells. Remaining wrapCode holes:
 *
 * - bare `return;` is a ReturnStatement so it wraps, but has no argument
 *   to rewrite — the IIFE swallows it
 * - await in a comment/string is not an AwaitExpression
 * - publishGlobals uses binding names (`b`, `rest`), not pattern keys (`a`)
 * - a method-body await is an execution boundary; the class itself must not wrap
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

describe("publishGlobals writes the binding names, not the pattern keys", () => {
	it("publishes a renamed destructure and a rest binding when the cell awaits", async () => {
		const result = await wrapCode("const { a: b, ...rest } = await load();");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain('this["b"] = b;');
		expect(result.source).toContain('this["rest"] = rest;');
		expect(result.source).not.toContain('this["a"] = a;');
	});
});

describe("execution boundaries stop at methods, not at the class declaration", () => {
	it("does not wrap a class whose only await is inside a method", async () => {
		const src = ["class Worker {", "  async run() {", "    return await this.step();", "  }", "}"].join("\n");
		const result = await wrapCode(src);
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("var Worker = class");
	});
});
