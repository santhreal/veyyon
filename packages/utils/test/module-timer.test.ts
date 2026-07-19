import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	addImportEdges,
	importerDir,
	instrumentContents,
	MODULE_LOADER_FILTER,
	STATIC_IMPORT_PATTERN,
} from "../src/module-timer";

// The timing machinery installs Bun plugin hooks only under VEYYON_TIMING and
// cannot be observed from a normal import (the preload runs before the test
// graph). What is independently verifiable is the pure instrumentation logic:
// the file filter, the static-import scanner regex, the source rewrite that
// appends body-start/completion markers, and the importer-directory split.

describe("MODULE_LOADER_FILTER", () => {
	it("matches every TypeScript source extension Bun instruments", () => {
		for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.mtsx", "a.ctsx", "types.d.ts"]) {
			expect(MODULE_LOADER_FILTER.test(name)).toBe(true);
		}
	});

	it("rejects JavaScript and non-source extensions so CJS keeps Bun's default loader", () => {
		for (const name of ["a.js", "a.jsx", "a.cjs", "a.mjs", "a.json", "a.txt", "a.tsxx", "ts"]) {
			expect(MODULE_LOADER_FILTER.test(name)).toBe(false);
		}
	});
});

describe("STATIC_IMPORT_PATTERN", () => {
	function specifiers(source: string): string[] {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const out: string[] = [];
		for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
			const spec = match[1] ?? match[2];
			if (spec) out.push(spec);
		}
		return out;
	}

	it("captures side-effect, default, named, namespace, and type imports", () => {
		const source = [
			`import "./side-effect";`,
			`import def from "./default";`,
			`import { a, b } from "./named";`,
			`import * as ns from "./namespace";`,
			`import type { T } from "./type-only";`,
		].join("\n");
		expect(specifiers(source)).toEqual(["./side-effect", "./default", "./named", "./namespace", "./type-only"]);
	});

	it("captures re-export specifiers and dynamic import() calls", () => {
		const source = [
			`export { x } from "./re-export";`,
			`export * from "./star-export";`,
			`const mod = await import("./dynamic");`,
			`import( "./spaced-dynamic" );`,
		].join("\n");
		expect(specifiers(source)).toEqual(["./re-export", "./star-export", "./dynamic", "./spaced-dynamic"]);
	});

	it("distinguishes single from double quotes and ignores non-import string literals", () => {
		const source = [`import a from './single';`, `const notAnImport = "./plain-string";`].join("\n");
		expect(specifiers(source)).toEqual(["./single"]);
	});
});

describe("instrumentContents", () => {
	it("wraps a plain module with a body-start prefix and completion suffix carrying the path", () => {
		const out = instrumentContents("/pkg/mod.ts", "export const x = 1;");
		expect(out).toBe(
			`;globalThis[Symbol.for("veyyon.moduleBodyStart")]?.("/pkg/mod.ts");\n` +
				"export const x = 1;" +
				`\n;globalThis[Symbol.for("veyyon.moduleLoadComplete")]?.("/pkg/mod.ts");\n`,
		);
	});

	it("JSON-escapes paths containing quotes and backslashes in both markers", () => {
		const weird = `/p"a\\th.ts`;
		const out = instrumentContents(weird, "1;");
		const encoded = JSON.stringify(weird);
		expect(out.startsWith(`;globalThis[Symbol.for("veyyon.moduleBodyStart")]?.(${encoded});\n`)).toBe(true);
		expect(out.endsWith(`\n;globalThis[Symbol.for("veyyon.moduleLoadComplete")]?.(${encoded});\n`)).toBe(true);
	});

	it("keeps a shebang on the first line and injects the start marker after it", () => {
		const out = instrumentContents("/bin/cli.ts", "#!/usr/bin/env bun\nconst x = 1;");
		const lines = out.split("\n");
		expect(lines[0]).toBe("#!/usr/bin/env bun");
		expect(lines[1]).toBe(`;globalThis[Symbol.for("veyyon.moduleBodyStart")]?.("/bin/cli.ts");`);
		expect(out.trimEnd().endsWith(`;globalThis[Symbol.for("veyyon.moduleLoadComplete")]?.("/bin/cli.ts");`)).toBe(
			true,
		);
	});

	it("handles a shebang-only file with no trailing newline", () => {
		const out = instrumentContents("/bin/only.ts", "#!/usr/bin/env bun");
		expect(out).toBe(
			"#!/usr/bin/env bun\n" +
				`;globalThis[Symbol.for("veyyon.moduleBodyStart")]?.("/bin/only.ts");\n` +
				`\n;globalThis[Symbol.for("veyyon.moduleLoadComplete")]?.("/bin/only.ts");\n`,
		);
	});
});

describe("importerDir", () => {
	it("returns the directory portion up to the last slash", () => {
		expect(importerDir("/a/b/c.ts")).toBe("/a/b");
		expect(importerDir("/root.ts")).toBe("");
	});

	it("returns '.' when the importer has no slash", () => {
		expect(importerDir("bare.ts")).toBe(".");
	});
});

describe("addImportEdges", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "module-timer-edges-"));
		await writeFile(path.join(dir, "child.ts"), "export const c = 1;\n");
		await writeFile(path.join(dir, "other.ts"), "export const o = 2;\n");
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("records resolved TS import edges and ignores unresolvable specifiers", () => {
		const importer = path.join(dir, "importer.ts");
		const edges = new Map<string, Set<string>>();
		const contents = [
			`import { c } from "./child";`,
			`import { o } from "./other.ts";`,
			`import missing from "./does-not-exist";`,
		].join("\n");
		addImportEdges(edges, importer, contents);
		const children = edges.get(importer);
		expect(children).toBeDefined();
		expect([...(children ?? [])].sort()).toEqual([path.join(dir, "child.ts"), path.join(dir, "other.ts")]);
	});

	it("does not record a self-edge when a module imports its own path", () => {
		const importer = path.join(dir, "child.ts");
		const edges = new Map<string, Set<string>>();
		addImportEdges(edges, importer, `import { c } from "./child";`);
		expect(edges.get(importer)?.size ?? 0).toBe(0);
	});
});
