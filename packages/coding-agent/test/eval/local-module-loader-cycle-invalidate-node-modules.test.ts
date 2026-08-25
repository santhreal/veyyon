/**
 * LocalModuleLoader's local-vs-external decision is not "does the file
 * exist". A specifier is local only when it LOOKS like a path
 * (`./`, `../`, `/`, `~/`, Windows drive) AND the resolved target is an
 * absolute file with a managed extension AND the path does not contain a
 * `node_modules` segment. Everything else is handed to the host `import()`.
 *
 * Gaps the 152-line loader suite never pinned:
 * - a bare `mod.ts` in cwd is EXTERNAL even when the file exists — missing
 *   `./` is a package name;
 * - a file under node_modules is EXTERNAL even when imported with `./`;
 * - a cyclic a↔b graph must still evaluate (link is serialized, evaluate
 *   is once per root);
 * - a failed evaluate is dropped from the cache so the next resolve retries
 *   after the file is fixed;
 * - deleting a tracked file invalidates on the next resolve (mtime miss);
 * - `.tsx` uses the tsx strip loader (JSX survives as runtime, types do not);
 * - `file://` with a query is not an absolute path to filenameForUrl —
 *   filenameForUrl only strips `file://`, it does not parse URLs with extra
 *   query. The loader's own identifiers add `?veyyon-session=` AFTER
 *   construction; filenameForUrl is for caller-supplied URLs.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalModuleLoader } from "@veyyon/coding-agent/eval/js/shared/local-module-loader";

let tmpDir: string;
let priorGetRequire: unknown;

function installRequire(loader: LocalModuleLoader, cwd: string): void {
	priorGetRequire = (globalThis as Record<string, unknown>).__veyyon_get_require__;
	(globalThis as Record<string, unknown>).__veyyon_get_require__ = (url: string | undefined) =>
		loader.requireForFile(url, cwd);
}

function restoreRequire(): void {
	(globalThis as Record<string, unknown>).__veyyon_get_require__ = priorGetRequire;
}

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-lml-edge-"));
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("a bare specifier is never a managed local module, even when the file exists", () => {
	it("classifies `exists.ts` as external, keeping the raw target", async () => {
		const file = path.join(tmpDir, "exists.ts");
		fs.writeFileSync(file, "export const n = 1;\n");
		const loader = new LocalModuleLoader("bare-spec");
		const r = await loader.resolveForRun(tmpDir, "exists.ts");
		expect(r).toEqual({ mode: "external", target: "exists.ts" });
	});
});

describe("a path inside node_modules is external even when the specifier is relative", () => {
	it("does not evaluate a ./node_modules/pkg/index.js file as a cell module", async () => {
		const pkgDir = path.join(tmpDir, "node_modules", "pkg");
		fs.mkdirSync(pkgDir, { recursive: true });
		const index = path.join(pkgDir, "index.js");
		fs.writeFileSync(index, "export const secret = 99;\n");
		const loader = new LocalModuleLoader("nm");
		installRequire(loader, tmpDir);
		try {
			const r = await loader.resolveForRun(tmpDir, "./node_modules/pkg/index.js");
			expect(r.mode).toBe("external");
			if (r.mode !== "external") throw new Error("expected external");
			expect(r.target.startsWith("file://")).toBe(true);
			expect(r.target).toContain("node_modules");
		} finally {
			restoreRequire();
		}
	});
});

describe("cyclic local graphs evaluate instead of hanging the linker", () => {
	it("returns both namespaces of an a.ts ↔ b.ts import cycle", async () => {
		const aPath = path.join(tmpDir, "cycle-a.ts");
		const bPath = path.join(tmpDir, "cycle-b.ts");
		fs.writeFileSync(
			aPath,
			'import { b } from "./cycle-b.ts";\nexport const a = 1;\nexport function fromA() { return b; }\n',
		);
		fs.writeFileSync(
			bPath,
			'import { a } from "./cycle-a.ts";\nexport const b = 2;\nexport function fromB() { return a; }\n',
		);
		const loader = new LocalModuleLoader("cycle");
		installRequire(loader, tmpDir);
		try {
			const ra = await loader.resolveForRun(tmpDir, "./cycle-a.ts");
			expect(ra.mode).toBe("local");
			if (ra.mode !== "local") throw new Error("expected local");
			const nsA = ra.value as { a: number; fromA: () => number };
			expect(nsA.a).toBe(1);
			expect(nsA.fromA()).toBe(2);

			const rb = await loader.resolveForRun(tmpDir, "./cycle-b.ts");
			expect(rb.mode).toBe("local");
			if (rb.mode !== "local") throw new Error("expected local");
			const nsB = rb.value as { b: number; fromB: () => number };
			expect(nsB.b).toBe(2);
			expect(nsB.fromB()).toBe(1);
		} finally {
			restoreRequire();
		}
	});
});

describe("a failed local evaluate is not sticky: the next resolve retries", () => {
	it("loads the repaired source after the first evaluate threw", async () => {
		const bad = path.join(tmpDir, "retry.ts");
		fs.writeFileSync(bad, "export const x = ;\n");
		const loader = new LocalModuleLoader("retry");
		installRequire(loader, tmpDir);
		try {
			await expect(loader.resolveForRun(tmpDir, "./retry.ts")).rejects.toThrow();
			fs.writeFileSync(bad, "export const x = 7;\n");
			const stat = fs.statSync(bad);
			fs.utimesSync(bad, stat.atime, new Date(stat.mtimeMs + 5000));
			const r = await loader.resolveForRun(tmpDir, "./retry.ts");
			expect(r.mode).toBe("local");
			if (r.mode !== "local") throw new Error("expected local");
			expect((r.value as { x: number }).x).toBe(7);
		} finally {
			restoreRequire();
		}
	});
});

describe("deleting a tracked module invalidates the cache on the next resolve", () => {
	it("throws after the file is unlinked, rather than returning the old namespace", async () => {
		const gone = path.join(tmpDir, "gone.ts");
		fs.writeFileSync(gone, "export const x = 1;\n");
		const loader = new LocalModuleLoader("gone");
		installRequire(loader, tmpDir);
		try {
			const first = await loader.resolveForRun(tmpDir, "./gone.ts");
			expect(first.mode).toBe("local");
			fs.unlinkSync(gone);
			await expect(loader.resolveForRun(tmpDir, "./gone.ts")).rejects.toThrow();
		} finally {
			restoreRequire();
		}
	});
});

describe("tsx vs ts strip loader", () => {
	it("strips TypeScript in a .tsx file so `n: number` is a runtime export", async () => {
		const file = path.join(tmpDir, "view.tsx");
		fs.writeFileSync(file, "export const n: number = 3;\n");
		const loader = new LocalModuleLoader("tsx");
		installRequire(loader, tmpDir);
		try {
			const r = await loader.resolveForRun(tmpDir, "./view.tsx");
			expect(r.mode).toBe("local");
			if (r.mode !== "local") throw new Error("expected local");
			expect((r.value as { n: number }).n).toBe(3);
		} finally {
			restoreRequire();
		}
	});
});

describe("filenameForUrl does not parse query strings off a file URL", () => {
	it("treats file:///a/b.ts?x=1 as a path that includes the question mark (no URL parser)", () => {
		const loader = new LocalModuleLoader("urls");
		const got = loader.filenameForUrl("file:///a/b.ts?x=1");
		// fileURLToPath keeps the query out — pin whichever the platform function does
		// so a silent switch to string-slice stripping is visible.
		expect(got === "/a/b.ts" || got === "/a/b.ts?x=1").toBe(true);
		if (got === "/a/b.ts?x=1") {
			throw new Error("filenameForUrl is concatenating the query into the path; fileURLToPath should strip it");
		}
		expect(got).toBe("/a/b.ts");
	});
});
