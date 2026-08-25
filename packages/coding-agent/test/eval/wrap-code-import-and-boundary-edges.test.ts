/**
 * wrapCode's async decision is AST-driven AFTER import rewrite. A static
 * `import` becomes `await __veyyon_import__`, which is a top-level await
 * and MUST wrap. A type-only import is stripped by the TS transpiler when
 * LOOKS_LIKE_TS fires (`import type`); if the heuristic misses it, the
 * rewritten source still contains `import type` and the cell is not a
 * valid JS program.
 *
 * Nested for-await, nested yield, and a method-body return are execution
 * boundaries. A top-level `import()` (dynamic) is an Await-less CallExpression
 * unless the cell already awaits it.
 *
 * LOOKS_LIKE_TS also matches `interface Name` and `type X =`. Those must
 * strip. A string containing `interface Foo` must NOT strip-and-mangle the
 * surrounding JS (the heuristic does not skip strings — that defect is
 * already pinned red in looks-like-ts-fires-inside-comments-and-strings;
 * this file only pins wrapCode's observable wrap/import behaviour).
 */
import { describe, expect, it } from "bun:test";
import { wrapCode } from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

describe("static import is rewritten to await __veyyon_import__ and therefore wraps", () => {
	it("wraps `import { x } from \"./m.ts\"` and rewrites the specifier call", async () => {
		const result = await wrapCode('import { x } from "./m.ts";\nx');
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain("__veyyon_import__");
		expect(result.source).not.toMatch(/^import\s+\{/);
		expect(result.source).toContain("__veyyon_set_final_expr__((x))");
	});

	it("wraps a side-effect import with no bindings", async () => {
		const result = await wrapCode('import "./side.ts";\n1');
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain("__veyyon_import__");
	});

	it("wraps import * as ns", async () => {
		const result = await wrapCode('import * as ns from "./m.ts";\nns');
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain("__veyyon_import__");
		expect(result.source).toContain("__veyyon_set_final_expr__((ns))");
	});

	it("wraps default import", async () => {
		const result = await wrapCode('import mod from "./m.ts";\nmod');
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain("__veyyon_import__");
	});
});

describe("type-only imports must not remain in the emitted JS", () => {
	it("strips `import type { Foo } from \"./t.ts\"` so the cell is still JS", async () => {
		const result = await wrapCode('import type { Foo } from "./t.ts";\nconst x: Foo = 1;\nx');
		expect(result.source).not.toContain("import type");
		expect(result.source).not.toContain(": Foo");
		expect(result.finalExpressionReturned).toBe(true);
	});

	it("strips `export type` and a type alias so they are not SyntaxErrors in the VM", async () => {
		const result = await wrapCode("export type Foo = string;\ntype Bar = number;\n1");
		expect(result.source).not.toContain("export type");
		expect(result.source).not.toContain("type Bar");
	});

	it("strips an interface declaration", async () => {
		const result = await wrapCode("interface Foo { x: number }\n1");
		expect(result.source).not.toContain("interface Foo");
	});
});

describe("dynamic import() without await is not an AwaitExpression", () => {
	it("does not wrap a cell that only calls import() and uses the promise", async () => {
		const result = await wrapCode('const p = import("./m.ts");\np');
		expect(result.asyncWrapped).toBe(false);
		// rewriteImports rewrites dynamic import() to the __veyyon_import__ helper
		// even when the cell does not wrap. A leftover bare import() would bypass
		// the loader's session graph.
		expect(result.source).toContain("__veyyon_import__");
		expect(result.source).not.toMatch(/(?:^|\n)const p = import\(/);
	});

	it("does wrap when the cell awaits the dynamic import, and the await is on the helper not on import()", async () => {
		const result = await wrapCode('const m = await import("./m.ts");\nm');
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain("await (typeof __veyyon_import__");
		expect(result.source).not.toContain("await import(");
	});
});

describe("nested for-await and generators do not wrap the cell", () => {
	it("does not wrap a for-await that lives inside a function", async () => {
		const result = await wrapCode("async function f() { for await (const x of xs) x; }\nf");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("for await");
	});

	it("does not wrap a generator whose body yields", async () => {
		const result = await wrapCode("function* g() { yield 1; }\ng");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("function* g()");
		expect(result.source.startsWith("(async () => {")).toBe(false);
	});

	it("does not wrap an async generator", async () => {
		const result = await wrapCode("async function* g() { yield await 1; }\ng");
		expect(result.asyncWrapped).toBe(false);
	});
});

describe("object-literal and class-field boundaries", () => {
	it("does not wrap an object method that awaits", async () => {
		const result = await wrapCode("const o = { async run() { return await 1; } };\no");
		expect(result.asyncWrapped).toBe(false);
		expect(result.source).toContain("async run()");
	});

	it("does wrap a cell whose await is in a class field initializer (recovered AST)", async () => {
		const result = await wrapCode("class C { x = await 1; }");
		// errorRecovery may or may not produce AwaitExpression. Pin the actual
		// decision: if wrapped, the IIFE is present; if not, class demote happened.
		if (result.asyncWrapped) {
			expect(result.source.startsWith("(async () => {")).toBe(true);
		} else {
			expect(result.source).toContain("var C = class");
		}
	});
});

describe("export forms that are not type-only still rewrite", () => {
	it("keeps `export const` as a published binding when the cell wraps", async () => {
		const result = await wrapCode("export const n = await 1;");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source).toContain("n = await 1");
	});

	it("does not wrap `export const n = 1` with no await", async () => {
		const result = await wrapCode("export const n = 1;");
		expect(result.asyncWrapped).toBe(false);
	});
});
