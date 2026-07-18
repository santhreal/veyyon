/**
 * Shared-cause lock for the bun process.exitCode-retention gotcha.
 *
 * Unlike Node, bun keeps the last NUMERIC `process.exitCode` even when it is
 * later reassigned `undefined`. A test that snapshots `const original =
 * process.exitCode` (usually undefined), sets `process.exitCode = 1` to
 * exercise a failure path, then "restores" `process.exitCode = original` does
 * NOT clear the 1 — it leaks into the test runner's own exit code, so a whole
 * chunk reports "0 fail" yet exits 1 and silently blocks the release CI (this
 * happened to commit-command-exit.test.ts and cost a release cut on 2026-07-18).
 *
 * The rule this guard enforces: if a file snapshots process.exitCode into a
 * variable, every restore of that variable must coerce with a `?? <number>`
 * fallback (e.g. `process.exitCode = original ?? 0`). It deliberately does NOT
 * flag production `process.exitCode = code` (code is not a process.exitCode
 * snapshot) so it stays false-positive-free.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const TEST_ROOT = path.resolve(import.meta.dir);

// This guard file embeds the anti-pattern in synthetic sample strings, so it
// excludes itself from the scan.
const SELF = path.basename(import.meta.file ?? "exit-code-restore-guard.test.ts");

function walkTestFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walkTestFiles(full));
		else if ((entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) && entry !== SELF) out.push(full);
	}
	return out;
}

// Identifiers this file assigns from `process.exitCode` (snapshots).
function snapshotIdents(source: string): Set<string> {
	const idents = new Set<string>();
	const re = /(?:^|[^.\w])([A-Za-z_$][\w$]*)\s*=\s*process\.exitCode\b/g;
	for (const m of source.matchAll(re)) idents.add(m[1]);
	return idents;
}

// Restores of `process.exitCode = <ident>` that lack a `?? <fallback>`.
function unguardedRestores(source: string, snapshots: Set<string>): string[] {
	const bad: string[] = [];
	const re = /process\.exitCode\s*=\s*([A-Za-z_$][\w$]*)\s*(\?\?)?/g;
	for (const m of source.matchAll(re)) {
		const ident = m[1];
		const hasCoalesce = m[2] === "??";
		if (snapshots.has(ident) && !hasCoalesce) bad.push(ident);
	}
	return bad;
}

describe("process.exitCode restore guard (bun retention gotcha)", () => {
	const files = walkTestFiles(TEST_ROOT);

	it("scans a non-trivial number of test files", () => {
		// Guards against a broken walk silently passing over an empty set.
		expect(files.length).toBeGreaterThan(200);
	});

	it("every snapshot of process.exitCode is restored with a ?? fallback", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			if (!source.includes("process.exitCode")) continue;
			const snapshots = snapshotIdents(source);
			if (snapshots.size === 0) continue;
			const bad = unguardedRestores(source, snapshots);
			if (bad.length > 0) {
				offenders.push(`${path.relative(TEST_ROOT, file)} → process.exitCode = ${bad.join(", ")} (needs \`?? 0\`)`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("detects the anti-pattern in a synthetic sample and accepts the guarded form", () => {
		const bad = "const original = process.exitCode;\nprocess.exitCode = 1;\nprocess.exitCode = original;";
		const good = "const original = process.exitCode;\nprocess.exitCode = 1;\nprocess.exitCode = original ?? 0;";
		expect(unguardedRestores(bad, snapshotIdents(bad))).toEqual(["original"]);
		expect(unguardedRestores(good, snapshotIdents(good))).toEqual([]);
	});
});
