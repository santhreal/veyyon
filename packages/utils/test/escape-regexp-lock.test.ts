import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { escapeRegExp } from "../src/regex";

// Repo-wide source lock: escapeRegExp has exactly ONE owner,
// packages/utils/src/regex.ts. Hand-rolled local copies drift (two character-
// class orderings already existed when this lock landed) — import the owner.
//
// GRANDFATHERED lists the sites that still carry a local copy. Convert a file,
// remove its entry — a stale entry fails the lock so the list can only shrink.
const GRANDFATHERED = new Set<string>([
	// Empty: every hand-rolled copy now imports escapeRegExp from @veyyon/utils.
]);

const PACKAGES_DIR = path.join(import.meta.dir, "../..");

// Matches any hand-rolled regex-escaper: escapeRegExp / escapeRegex /
// escapeRegexLiteral (and future variants). Anchored on "escapeReg" + word
// chars — the earlier form ("escapeRege…") silently missed the capital-E
// "escapeRegExp" spelling, letting a third copy slip through the lock.
const LOCAL_DEF = /function\s+escapeReg\w*\s*\(/;

async function walk(dir: string, out: string[], includeTests: boolean): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out, includeTests);
		} else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) {
			out.push(full);
		}
	}
}

// Collect .ts files across every package. `dirs` names the per-package
// subdirectories to scan (src for production, test for the suites) — the
// production check scans src only; the test check scans test too, because a
// hand-rolled copy in a test helper is still a second definition that drifts,
// and the src-only scan never saw it (that is exactly how one slipped in).
async function collectFiles(dirs: readonly string[], includeTests: boolean): Promise<string[]> {
	const files: string[] = [];
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		for (const sub of dirs) {
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, sub), files, includeTests);
			} catch {
				// Package without that subdirectory (assets-only) — nothing to scan.
			}
		}
	}
	return files;
}

function sourceFiles(): Promise<string[]> {
	return collectFiles(["src"], false);
}

function testFiles(): Promise<string[]> {
	return collectFiles(["test"], true);
}

describe("escapeRegExp source lock", () => {
	it("escapes every regex metacharacter and nothing else", () => {
		expect(escapeRegExp("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(
			"a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o",
		);
		expect(escapeRegExp("plain-text_123")).toBe("plain-text_123");
		expect(new RegExp(`^${escapeRegExp("a.b*c")}$`).test("a.b*c")).toBe(true);
		expect(new RegExp(`^${escapeRegExp("a.b*c")}$`).test("aXbbbc")).toBe(false);
	});

	it("no production source defines a local escapeRegExp outside the grandfathered set", async () => {
		const offenders: string[] = [];
		const cleared: string[] = [];
		const seen = new Set<string>();
		for (const file of await sourceFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (rel === "utils/src/regex.ts") continue;
			const text = await readFile(file, "utf8");
			if (!LOCAL_DEF.test(text)) continue;
			seen.add(rel);
			if (!GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		for (const rel of GRANDFATHERED) {
			if (!seen.has(rel)) cleared.push(rel);
		}
		expect(offenders, "new local escapeRegExp copies — import it from @veyyon/utils instead").toEqual([]);
		expect(cleared, "grandfathered entries whose local copy is gone — remove them from the list").toEqual([]);
	});

	it("no test file defines a local escapeRegExp — tests must dogfood the owner too", async () => {
		const offenders: string[] = [];
		for (const file of await testFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (LOCAL_DEF.test(await readFile(file, "utf8"))) offenders.push(rel);
		}
		expect(offenders, "test-local escapeRegExp copies — import it from @veyyon/utils instead").toEqual([]);
	});
});
