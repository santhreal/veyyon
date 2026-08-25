/**
 * rewriteImports has a cheap `code.includes("import")` gate, then two
 * different rewrites on the same AST:
 *
 * - top-level ImportDeclaration nodes become `await __veyyon_import__(...)`
 * - every CallExpression whose callee is Import (dynamic import()) has only
 *   the callee swapped for DYNAMIC_IMPORT_CALLEE, which is a typeof-guard that
 *   falls back to native import() so puppeteer-serialized functions keep
 *   working in the page.
 *
 * The walk is not limited to program.body: a dynamic import inside a nested
 * function is rewritten. A string or template that merely contains the
 * characters import( is not a CallExpression and must stay bytes-identical,
 * even though the cheap gate opened.
 *
 * wrapCode runs rewriteImports BEFORE requiresAsyncWrapper. A static import
 * therefore becomes a top-level await and forces the async IIFE. That is the
 * intended coupling (the worker must wait the load); this file pins it so a
 * future "don't wrap imports" change cannot land unnoticed. A dynamic import
 * inside a function does not force the wrapper, because isExecutionBoundary
 * stops the await walk.
 */
import { describe, expect, it } from "bun:test";
import { rewriteImports, wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";


describe("the characters import( in a string or template are not a CallExpression", () => {
	it("leaves a string containing import('x') byte-identical", async () => {
		const src = "const s = \"import('x')\";";
		expect(await rewriteImports(src)).toBe(src);
	});

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
		const src = [
			"async function load(name) {",
			"  return import(name);",
			"}",
			"load",
		].join("\n");
		const result = await wrapCode(src);
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("__veyyon_import__");
		expect(result.finalExpressionReturned).toBe(true);
	});
});
