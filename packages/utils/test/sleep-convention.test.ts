import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

// Repo-wide sleep convention. This codebase has exactly ONE primitive for
// "wait N milliseconds": `Bun.sleep(ms)` (used in ~80 production sites). The
// abort-aware form is also settled: `untilAborted(signal, () => Bun.sleep(ms))`
// rejects with the shared AbortError. Hand-rolling a wait as
// `new Promise(resolve => setTimeout(resolve, ms))` reinvents Bun.sleep and
// splits the primitive across two owners; a local `sleep`/`delay` wrapper that
// only forwards to Bun.sleep is the same split with a name. Both were found and
// removed (mcp/manager.ts delay wrapper, ai mock.ts sleep helper, tts-worker and
// tui terminal inline promises), so the grandfathered set is empty: any new
// occurrence fails this lock. Call Bun.sleep directly, or untilAborted when the
// wait must cancel.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

// `new Promise(resolve => setTimeout(resolve, ...))`: the promise's own resolver
// is passed straight to setTimeout as its callback. The \1 backreference pins
// the setTimeout callback to the same identifier the arrow bound, so this only
// matches a bare sleep, never a timer whose callback does real work (AsyncDrain
// exec, backpressure drains) or a standalone setTimeout with a captured resolver
// (lsp/client.ts projectLoadTimeout).
const INLINE_SLEEP_PROMISE = /new Promise(?:<[^>]*>)?\(\s*(?:async\s+)?\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\b/;

// A local function whose whole body forwards to Bun.sleep — a renamed alias of
// the one primitive. The body must be exactly `{ return Bun.sleep(...); }` so a
// timeout-race helper (`return Bun.sleep(ms).then(...)`) is not a false match.
const SLEEP_ALIAS = /function\s+\w+\s*\([^)]*\)\s*(?::[^{]+)?\{\s*return\s+Bun\.sleep\([^)]*\);?\s*\}/;

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

async function sourceFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		try {
			await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
		} catch {
			// Package without a src/ directory (assets-only) — nothing to scan.
		}
	}
	return files;
}

describe("sleep convention source lock", () => {
	it("no production source hand-rolls a wait with new Promise + setTimeout, or aliases Bun.sleep", async () => {
		const inlineOffenders: string[] = [];
		const aliasOffenders: string[] = [];
		for (const file of await sourceFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			const text = await readFile(file, "utf8");
			if (INLINE_SLEEP_PROMISE.test(text)) inlineOffenders.push(rel);
			if (SLEEP_ALIAS.test(text)) aliasOffenders.push(rel);
		}
		expect(
			inlineOffenders,
			"inline `new Promise(resolve => setTimeout(resolve, ms))` — call Bun.sleep(ms), or untilAborted(signal, () => Bun.sleep(ms)) when the wait must cancel",
		).toEqual([]);
		expect(aliasOffenders, "local function that only forwards to Bun.sleep — call Bun.sleep directly").toEqual([]);
	});
});
