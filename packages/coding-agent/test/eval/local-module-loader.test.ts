import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalModuleLoader } from "@veyyon/coding-agent/eval/js/shared/local-module-loader";

/**
 * LocalModuleLoader is the eval cell's local-import resolver: it decides whether an
 * import specifier names a managed on-disk module (loaded, TypeScript-stripped,
 * linked, evaluated, and hot-reloaded inside the cell's vm context) or an external
 * package/URL/builtin handed off to the host runtime. This whole 368-line class was
 * untested. These lock the load-bearing contracts:
 *
 *  - the local-vs-external decision (a relative/absolute path to a .ts/.js file is
 *    local; a bare package, a node: builtin, and an http(s) URL are external), since
 *    a misclassification would either run untracked host code as a cell module or
 *    refuse to load a real local file;
 *  - the file:// / absolute / relative URL helpers used to derive a module's base
 *    directory for resolving its own relative imports;
 *  - the end-to-end load of a real local module, its exact exported values, and a
 *    cross-module import between two local files;
 *  - hot-reload: editing a tracked module makes the next resolve return the new
 *    export, proving the mtime-tracking invalidation actually re-evaluates.
 *
 * The evaluated module source calls `globalThis.__veyyon_get_require__` (the require
 * bridge the executor wires at runtime); the local-loading suite installs it around
 * the loader and restores the prior value afterward so the global does not leak.
 */

describe("LocalModuleLoader — URL helpers", () => {
	const loader = new LocalModuleLoader("url-helpers");

	it("filenameForUrl converts a file:// URL to an absolute path", () => {
		expect(loader.filenameForUrl("file:///a/b.ts")).toBe("/a/b.ts");
	});

	it("filenameForUrl passes an absolute path through", () => {
		expect(loader.filenameForUrl("/abs/x.ts")).toBe("/abs/x.ts");
	});

	it("filenameForUrl returns null for a relative path or nothing", () => {
		expect(loader.filenameForUrl("rel/x.ts")).toBeNull();
		expect(loader.filenameForUrl(undefined)).toBeNull();
	});

	it("dirnameForUrl returns the module's directory for a file:// URL", () => {
		expect(loader.dirnameForUrl("file:///a/b.ts", "/cwd")).toBe("/a");
	});

	it("dirnameForUrl falls back to cwd for a relative path or nothing", () => {
		expect(loader.dirnameForUrl("rel/x.ts", "/cwd")).toBe("/cwd");
		expect(loader.dirnameForUrl(undefined, "/cwd")).toBe("/cwd");
	});

	it("requireForFile returns a working require anchored at the file", () => {
		const req = loader.requireForFile(undefined, "/tmp");
		expect(typeof req).toBe("function");
		expect((req("node:path") as { sep: string }).sep).toBe(path.sep);
	});
});

describe("LocalModuleLoader — external resolution", () => {
	const loader = new LocalModuleLoader("external");

	it("classifies an unresolvable bare specifier as external, keeping the raw target", async () => {
		const r = await loader.resolveForRun("/tmp", "no-such-pkg-xyz-123");
		expect(r).toEqual({ mode: "external", target: "no-such-pkg-xyz-123" });
	});

	it("classifies a node: builtin as external", async () => {
		const r = await loader.resolveForRun("/tmp", "node:fs");
		expect(r).toEqual({ mode: "external", target: "node:fs" });
	});

	it("passes an http(s) URL through as an external target unchanged", async () => {
		const r = await loader.resolveForRun("/tmp", "https://esm.sh/left-pad@1.3.0");
		expect(r).toEqual({ mode: "external", target: "https://esm.sh/left-pad@1.3.0" });
	});
});

describe("LocalModuleLoader — local module loading", () => {
	let tmpDir: string;
	let loader: LocalModuleLoader;
	let priorGetRequire: unknown;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-lml-"));
		fs.writeFileSync(
			path.join(tmpDir, "mod.ts"),
			'export const answer: number = 42;\nexport function greet(name: string): string { return "hi " + name; }\n',
		);
		fs.writeFileSync(
			path.join(tmpDir, "main.ts"),
			'import { answer } from "./mod.ts";\nexport const doubled = answer * 2;\n',
		);
		loader = new LocalModuleLoader("local-loading");
		priorGetRequire = (globalThis as Record<string, unknown>).__veyyon_get_require__;
		(globalThis as Record<string, unknown>).__veyyon_get_require__ = (url: string | undefined) =>
			loader.requireForFile(url, tmpDir);
	});

	afterAll(() => {
		(globalThis as Record<string, unknown>).__veyyon_get_require__ = priorGetRequire;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads a local .ts module and exposes its exact exports (TypeScript stripped)", async () => {
		const r = await loader.resolveForRun(tmpDir, "./mod.ts");
		expect(r.mode).toBe("local");
		if (r.mode !== "local") throw new Error("expected a local resolution");
		const ns = r.value as { answer: number; greet: (n: string) => string };
		expect(ns.answer).toBe(42);
		expect(ns.greet("world")).toBe("hi world");
	});

	it("resolves a cross-module import between two local files", async () => {
		const r = await loader.resolveForRun(tmpDir, "./main.ts");
		expect(r.mode).toBe("local");
		if (r.mode !== "local") throw new Error("expected a local resolution");
		expect((r.value as { doubled: number }).doubled).toBe(84);
	});

	it("resolves a specifier relative to the importing module's directory, not the cwd", async () => {
		// resolveForModule derives the base dir from the module URL, so a totally
		// unrelated cwd must not change which file "./mod.ts" resolves to.
		const moduleUrl = `file://${path.join(tmpDir, "main.ts")}`;
		const r = await loader.resolveForModule(moduleUrl, "./mod.ts", "/nonexistent-cwd");
		expect(r.mode).toBe("local");
		if (r.mode !== "local") throw new Error("expected a local resolution");
		expect((r.value as { answer: number }).answer).toBe(42);
	});

	it("hot-reloads an edited module: the next resolve returns the new export", async () => {
		const hotPath = path.join(tmpDir, "hot.ts");
		fs.writeFileSync(hotPath, "export const v = 1;\n");
		const first = await loader.resolveForRun(tmpDir, "./hot.ts");
		expect(first.mode).toBe("local");
		if (first.mode !== "local") throw new Error("expected a local resolution");
		expect((first.value as { v: number }).v).toBe(1);

		fs.writeFileSync(hotPath, "export const v = 2;\n");
		// Force a distinct mtime so the change is observable regardless of filesystem
		// timestamp granularity (the loader reloads only when mtimeMs differs).
		const stat = fs.statSync(hotPath);
		fs.utimesSync(hotPath, stat.atime, new Date(stat.mtimeMs + 5000));

		const second = await loader.resolveForRun(tmpDir, "./hot.ts");
		expect(second.mode).toBe("local");
		if (second.mode !== "local") throw new Error("expected a local resolution");
		expect((second.value as { v: number }).v).toBe(2);
	});
});
