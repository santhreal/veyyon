import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `@veyyon/natives` loads its `.node` addon LAZILY: each class/function export
 * is a thin accessor that calls `loadNative()` only on first use, never at
 * import (DOCS-NATIVES-1). This is what lets a pure registry / schema /
 * doc-truth import whose transitive graph merely mentions `@veyyon/natives` run
 * on a fresh checkout with no built addon — the doc-truth test validates
 * documented commands against static registries and never executes a tool, yet
 * used to hard-fail because the old `const nativeBindings = loadNative()` at the
 * top of `native/index.js` (plus `export const X = nativeBindings.X` per symbol)
 * dlopen'd the addon the moment the module was imported.
 *
 * Two things are locked here:
 *
 *  1. BEHAVIOR — proven in a child process via the loader's own startup marker
 *     (`VEYYON_DEBUG_STARTUP` writes `native:loadNative:start` to stderr the
 *     instant `loadNative()` runs). Importing the module and reading an enum /
 *     referencing a function must emit NO such marker; the first real call must
 *     emit exactly one. Deferral, not a silent fallback: the first use still
 *     loads-or-throws loudly (Law 10).
 *
 *  2. SOURCE SHAPE — the generated block in `native/index.js`, and the generator
 *     that rewrites it (`scripts/gen-enums.ts`), must keep using the lazy
 *     accessors. A regression to the eager `nativeBindings.X` pattern re-breaks
 *     DOCS-NATIVES-1 with no runtime symptom on a host that has the addon, so
 *     the source is asserted directly.
 */

const NATIVE_DIR = path.resolve(import.meta.dir, "..", "native");
const INDEX_JS = path.join(NATIVE_DIR, "index.js");
const GEN_ENUMS = path.resolve(import.meta.dir, "..", "scripts", "gen-enums.ts");
const LOAD_MARKER = "native:loadNative:start";

/** Run a snippet in a child bun with the startup marker on; return its stderr. */
async function runWithMarker(snippet: string): Promise<string> {
	const proc = Bun.spawn([process.execPath, "-e", snippet], {
		cwd: path.resolve(import.meta.dir, "..", "..", ".."),
		env: { ...process.env, VEYYON_DEBUG_STARTUP: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return stderr;
}

function countMarker(stderr: string): number {
	return stderr.split(LOAD_MARKER).length - 1;
}

const INDEX_URL = `file://${INDEX_JS}`;

describe("lazy native addon loading (DOCS-NATIVES-1)", () => {
	it("does NOT load the addon when the module is imported and only enums/references are read", async () => {
		// Import, read a pure enum literal, and reference (never call) a native
		// function. None of this needs the .node, so the loader must stay silent.
		const stderr = await runWithMarker(
			`import { MacOSAppearance, astEdit, Process } from ${JSON.stringify(INDEX_URL)};` +
				`void astEdit; void Process;` +
				`if (MacOSAppearance.Dark !== "dark") throw new Error("enum literal wrong: " + MacOSAppearance.Dark);` +
				`process.stdout.write("ok");`,
		);
		expect(countMarker(stderr)).toBe(0);
	});

	it("loads the addon exactly once on the first real function call", async () => {
		// The first call resolves the binding; a second call reuses the memoized
		// one, so the marker appears exactly once, not per-call.
		const stderr = await runWithMarker(
			`import { getSupportedLanguages } from ${JSON.stringify(INDEX_URL)};` +
				`const a = getSupportedLanguages(); const b = getSupportedLanguages();` +
				`if (!Array.isArray(a) || a.length === 0) throw new Error("no languages");` +
				`if (a.length !== b.length) throw new Error("second call diverged");`,
		);
		expect(countMarker(stderr)).toBe(1);
	});

	it("does NOT load the addon merely from referencing a class export (typeof)", async () => {
		// A class export is a constructor-shaped Proxy; inspecting it without
		// `new`/static access must not trip the loader.
		const stderr = await runWithMarker(
			`import { PtySession, Shell } from ${JSON.stringify(INDEX_URL)};` +
				`if (typeof PtySession !== "function") throw new Error("class export not a constructor");` +
				`if (typeof Shell !== "function") throw new Error("class export not a constructor");` +
				`process.stdout.write("ok");`,
		);
		expect(countMarker(stderr)).toBe(0);
	});

	it("keeps native/index.js on the lazy accessors, never an eager nativeBindings read", () => {
		const source = fs.readFileSync(INDEX_JS, "utf8");
		// The eager pattern that broke DOCS-NATIVES-1 must not reappear anywhere.
		expect(source).not.toContain("nativeBindings");
		expect(source).not.toContain("= loadNative()");
		// Every class/function export routes through a lazy accessor.
		expect(source).toContain('import { lazyNativeClass, lazyNativeFn } from "./loader-state.js"');
		expect(source).toContain('export const Process = lazyNativeClass("Process");');
		expect(source).toContain('export const highlightCode = lazyNativeFn("highlightCode");');
		// Sanity: the generated block still carries the whole surface (many exports).
		const exportCount = (source.match(/^export const /gm) ?? []).length;
		expect(exportCount).toBeGreaterThan(40);
	});

	it("gen-enums.ts emits the lazy accessor pattern so regeneration cannot reintroduce eager loads", () => {
		const source = fs.readFileSync(GEN_ENUMS, "utf8");
		expect(source).toContain("lazyNativeClass(");
		expect(source).toContain("lazyNativeFn(");
		// The old eager template string must be gone from both emit sites.
		expect(source).not.toContain("= nativeBindings.");
	});
});
