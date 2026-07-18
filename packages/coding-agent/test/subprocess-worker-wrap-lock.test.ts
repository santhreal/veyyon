/**
 * Single-owner lock for the ref-counted worker-handle wrapper.
 *
 * The stt, tts, and tiny-title subprocess clients used to each hand-roll an
 * identical `wrapSubprocess` (createWorkerHandle + safeSend + ref()/unref()
 * swallowing the post-exit throw) and an identical `spawnInlineUnavailableWorker`
 * (createUnavailableWorker + no-op ref/unref) — three byte-for-byte copies
 * differing only by worker types and the safeSend label. They now share the
 * single owner in `subprocess/worker-client.ts`: `wrapRefCountedSubprocess` and
 * `refCountedUnavailableWorker`. This lock fails if a fourth copy reappears or
 * a second owner is declared, so the pattern can only stay unified.
 *
 * (embed-client keeps its OWN plain, non-ref-counted `wrapSubprocess` that uses
 * a raw `proc.send` whose throw must propagate — a deliberate divergence, not a
 * copy — so the offender scan targets the specific ref-counted-copy shapes, not
 * the name alone.)
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "../src");
const OWNER = "subprocess/worker-client.ts";

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

// The removed copies: a ref-counted unavailable stub (createUnavailableWorker
// spread with no-op ref/unref) and the old `spawnInlineUnavailableWorker` name.
const REFCOUNTED_UNAVAILABLE_COPY = /\.\.\.createUnavailableWorker<[^>]*>\([^)]*\)[\s\S]{0,40}ref\(\)\s*\{\}/;
const OLD_INLINE_UNAVAILABLE_DEF = /function\s+spawnInlineUnavailableWorker\s*\(/;

describe("ref-counted worker wrapper single-owner lock", () => {
	const files = walk(SRC_ROOT);

	it("scans a non-trivial number of source files", () => {
		expect(files.length).toBeGreaterThan(500);
	});

	it("declares wrapRefCountedSubprocess and refCountedUnavailableWorker exactly once, in worker-client", () => {
		const wrapOwners: string[] = [];
		const unavailableOwners: string[] = [];
		for (const file of files) {
			const rel = path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
			const text = readFileSync(file, "utf8");
			if (/export function wrapRefCountedSubprocess\b/.test(text)) wrapOwners.push(rel);
			if (/export function refCountedUnavailableWorker\b/.test(text)) unavailableOwners.push(rel);
		}
		expect(wrapOwners).toEqual([OWNER]);
		expect(unavailableOwners).toEqual([OWNER]);
	});

	it("no client re-hand-rolls the ref-counted unavailable-worker copy", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const rel = path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
			if (rel === OWNER) continue;
			const text = readFileSync(file, "utf8");
			if (OLD_INLINE_UNAVAILABLE_DEF.test(text) || REFCOUNTED_UNAVAILABLE_COPY.test(text)) offenders.push(rel);
		}
		expect(offenders, "import refCountedUnavailableWorker from subprocess/worker-client instead").toEqual([]);
	});
});
