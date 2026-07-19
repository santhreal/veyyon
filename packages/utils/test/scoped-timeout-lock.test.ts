import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

// Repo-wide source lock: bare `AbortSignal.timeout(ms)` keeps its backing timer
// armed for the full window after the guarded operation settles — under load
// that accumulates thousands of live timers and is the documented Bun
// concurrent-GC crash trigger. Production code must use the scoped owners in
// packages/utils/src/scoped-timeout.ts (scopedTimeoutSignal / raceWithTimeout /
// withScopedTimeoutSignal), which cancel the timer on settle.
//
// GRANDFATHERED lists the sites that still carry the bare form. Convert a file,
// remove its entry — a stale entry fails the lock so the list can only shrink.
const GRANDFATHERED = new Set([
	// Doc comment explaining the absolute-deadline semantics, not a live timer.
	"ai/src/utils/idle-iterator.ts",
	// Remaining live sites, owned by in-flight work on these files; convert to
	// scopedTimeoutSignal (cancel in finally, fence spanning body reads) when
	// that work lands.
	"coding-agent/src/session/agent-session.ts",
	"coding-agent/src/extensibility/plugins/marketplace/fetcher.ts",
	"coding-agent/src/task/executor.ts",
]);

const PACKAGES_DIR = path.join(import.meta.dir, "../..");

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
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
		const src = path.join(PACKAGES_DIR, pkg.name, "src");
		try {
			await walk(src, files);
		} catch {
			// Package without a src/ directory (assets-only) — nothing to scan.
		}
	}
	return files;
}

describe("scoped-timeout source lock", () => {
	it("no production source arms a bare AbortSignal.timeout outside the grandfathered set", async () => {
		const offenders: string[] = [];
		const cleared: string[] = [];
		const seen = new Set<string>();
		for (const file of await sourceFiles()) {
			const rel = path.relative(PACKAGES_DIR, file);
			// scoped-timeout.ts is the one legitimate owner of the raw call.
			if (rel === path.join("utils", "src", "scoped-timeout.ts")) continue;
			const src = await readFile(file, "utf-8");
			if (!src.includes("AbortSignal.timeout(")) continue;
			seen.add(rel);
			if (!GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		for (const entry of GRANDFATHERED) if (!seen.has(entry)) cleared.push(entry);
		// New bare sites are a regression; converted sites must leave the list.
		expect(offenders).toEqual([]);
		expect(cleared).toEqual([]);
	});
});
