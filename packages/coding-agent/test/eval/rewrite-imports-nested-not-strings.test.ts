/**
 * js-static-import-rewrite.test.ts already pins template-embedded import()
 * lookalikes. Remaining: wrapCode runs rewriteImports BEFORE the async-wrapper
 * walk, so a static import becomes a top-level await and forces the IIFE,
 * while a nested import() is rewritten but does not wrap.
 */
import { describe, expect, it } from "bun:test";
import { wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

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
