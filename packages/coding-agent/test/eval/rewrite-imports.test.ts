import { describe, expect, it } from "bun:test";
import {
	collectModuleSourceSpecifiers,
	rewriteDynamicImports,
	rewriteImports,
	rewriteModuleSourceSpecifiers,
	stripTypeScriptSyntax,
	wrapCode,
} from "@veyyon/coding-agent/eval/js/shared/rewrite-imports";

/**
 * rewrite-imports.ts rewrites eval-cell source so ESM imports route through the
 * worker-injected __veyyon_import__ helper (which resolves specifiers against the
 * session cwd) and top-level lexicals persist across cells. It is pure, parser-backed
 * transformation with no test coverage. These tests pin the generated text for every
 * import shape, prove strings/comments are left intact, and lock the string-literal
 * import-name regression: `import { "a-b" as c }` must quote the destructuring key or
 * the emitted `const { a-b: c } = ...` is a syntax error.
 */

describe("rewriteImports static import shapes", () => {
	it("rewrites a default import into an awaited .default access", async () => {
		expect(await rewriteImports('import foo from "bar";')).toBe(
			'const foo = (await __veyyon_import__("bar")).default;',
		);
	});

	it("rewrites a named import with shorthand for same-named bindings", async () => {
		expect(await rewriteImports('import { a, b } from "bar";')).toBe(
			'const { a, b } = await __veyyon_import__("bar");',
		);
	});

	it("rewrites a renamed named import into a key:value destructure", async () => {
		expect(await rewriteImports('import { a as b } from "bar";')).toBe(
			'const { a: b } = await __veyyon_import__("bar");',
		);
	});

	it("rewrites a namespace import into the module object", async () => {
		expect(await rewriteImports('import * as ns from "bar";')).toBe('const ns = await __veyyon_import__("bar");');
	});

	it("rewrites a default plus namespace import", async () => {
		expect(await rewriteImports('import foo, * as ns from "bar";')).toBe(
			'const ns = await __veyyon_import__("bar"); const foo = ns.default;',
		);
	});

	it("rewrites a default plus named import by prepending the default key", async () => {
		expect(await rewriteImports('import foo, { a } from "bar";')).toBe(
			'const { default: foo, a } = await __veyyon_import__("bar");',
		);
	});

	it("rewrites a side-effect-only import into a bare await", async () => {
		expect(await rewriteImports('import "bar";')).toBe('await __veyyon_import__("bar");');
	});

	it("quotes a string-literal import name so the destructure stays valid (regression)", async () => {
		// import { "a-b" as c } is valid ESM for exotic export names; the key must be
		// quoted. Before the fix this emitted `const { a-b: c } = ...`, a syntax error.
		expect(await rewriteImports('import { "a-b" as c } from "bar";')).toBe(
			'const { "a-b": c } = await __veyyon_import__("bar");',
		);
	});

	it("forwards import attributes as a with-options bag", async () => {
		expect(await rewriteImports('import data from "./d.json" with { type: "json" };')).toBe(
			'const data = (await __veyyon_import__("./d.json", { with: { type: "json" } })).default;',
		);
	});
});

describe("rewriteImports dynamic imports and inert text", () => {
	it("swaps the dynamic import callee for the guarded helper", async () => {
		const out = await rewriteImports('const m = await import("x");');
		expect(out).toContain('typeof __veyyon_import__ === "function" ? __veyyon_import__');
		expect(out).toContain('("x")');
	});

	it("leaves an import written inside a string literal untouched", async () => {
		const code = "const s = 'import foo from \"y\"';";
		expect(await rewriteImports(code)).toBe(code);
	});

	it("leaves an import written inside a comment untouched", async () => {
		const code = 'const x = 1; // import foo from "y"';
		expect(await rewriteImports(code)).toBe(code);
	});

	it("returns the source unchanged when it contains no import token", async () => {
		expect(await rewriteImports("const x = 1;")).toBe("const x = 1;");
	});
});

describe("collectModuleSourceSpecifiers", () => {
	it("collects sources from import and re-export declarations in order", async () => {
		const code = 'import a from "x";\nexport { b } from "y";\nexport * from "z";';
		expect(await collectModuleSourceSpecifiers(code)).toEqual(["x", "y", "z"]);
	});

	it("returns an empty list for source with no module declarations", async () => {
		expect(await collectModuleSourceSpecifiers("const x = 1;")).toEqual([]);
	});
});

describe("rewriteModuleSourceSpecifiers", () => {
	it("rewrites only the specifier text, leaving the rest of the declaration intact", async () => {
		const out = await rewriteModuleSourceSpecifiers('import a from "x";\nexport * from "y";', s => `/abs/${s}`);
		expect(out).toBe('import a from "/abs/x";\nexport * from "/abs/y";');
	});

	it("makes no edit when the replacer returns the same specifier", async () => {
		const code = 'import a from "x";';
		expect(await rewriteModuleSourceSpecifiers(code, s => s)).toBe(code);
	});
});

describe("rewriteDynamicImports", () => {
	it("defaults the callee to the worker import helper", async () => {
		expect(await rewriteDynamicImports('await import("x");')).toBe('await __veyyon_import__("x");');
	});

	it("honors a custom callee name", async () => {
		expect(await rewriteDynamicImports('await import("x");', "myImport")).toBe('await myImport("x");');
	});

	it("leaves a static import declaration alone", async () => {
		const code = 'import a from "x";';
		expect(await rewriteDynamicImports(code)).toBe(code);
	});
});

describe("stripTypeScriptSyntax", () => {
	it("strips a value-level type annotation", async () => {
		const out = stripTypeScriptSyntax("const x: number = 1;");
		expect(out).toContain("const x = 1");
		expect(out).not.toContain(": number");
	});

	it("strips a type-only import", async () => {
		const out = stripTypeScriptSyntax('import type { T } from "x";\nconst y = 1;');
		expect(out).not.toContain("import type");
		expect(out).toContain("const y = 1");
	});

	it("leaves plain JavaScript untouched by the heuristic", async () => {
		const code = "const x = 1;\n";
		expect(stripTypeScriptSyntax(code)).toBe(code);
	});
});

describe("wrapCode", () => {
	it("captures a trailing expression as the returned final value", async () => {
		const result = await wrapCode("1 + 1");
		expect(result.source).toBe("__veyyon_set_final_expr__((1 + 1));");
		expect(result.asyncWrapped).toBe(false);
		expect(result.finalExpressionReturned).toBe(true);
	});

	it("wraps in an async IIFE when top-level await is present", async () => {
		const result = await wrapCode("await foo()");
		expect(result.asyncWrapped).toBe(true);
		expect(result.source.startsWith("(async () => {")).toBe(true);
		expect(result.source).toContain("__veyyon_set_final_expr__((await foo()))");
	});

	it("demotes a top-level const to var so it persists across cells", async () => {
		const result = await wrapCode("const x = 1;");
		expect(result.source).toBe("var x = 1;");
		expect(result.asyncWrapped).toBe(false);
		expect(result.finalExpressionReturned).toBe(false);
	});
});
