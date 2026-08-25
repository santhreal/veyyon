/**
 * rewriteImports has a cheap `code.includes("import")` gate, then two
 * rewrites on the same AST. rewrite-imports.test.ts already pins a string
 * literal containing `import foo from "y"`. Remaining:
 *
 * - a template that contains the characters `import(` is not a CallExpression
 * - wrapCode runs rewriteImports BEFORE requiresAsyncWrapper, so a static
 *   import becomes a top-level await and forces the IIFE
 * - a dynamic import inside a function is rewritten but does not wrap,
 *   because isExecutionBoundary stops the await walk
 */
import { describe, expect, it } from "bun:test";
import { rewriteImports, wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("the characters import( in a template are not a CallExpression", () => {
	it("leaves a template containing import() byte-identical", async () => {
		const src = "const s = `import(${mod})`;";
		expect(await rewriteImports(src)).toBe(src);
	});
});

describe("a static import forces the async wrapper; a nested dynamic import does not", () => {
	it("wraps a cell that is only a static import, because rewrite produced a top-level await", async () => {
		const result = await wrapCode("import { readFile } from 'node:fs/promises';");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source.startsWith("(async () => {")).toBe(true);
		expect(result.source).toContain("__veyyon_import__");
	});

	it("does not wrap a cell whose only import() is inside a function", async () => {
		const src = ["async function load(name) {", "  return import(name);", "}", "load"].join("\n");
		const result = await wrapCode(src);
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("__veyyon_import__");
		expect(result.finalExpressionReturned).toBe(true);
	});
});
