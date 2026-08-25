/**
 * Every internal URL scheme has at least one dedicated test file or an audited exemption.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle: if the port passes every test, behavior is identical. An internal
 * URL scheme with no dedicated test file or audited test coverage is a
 * parity gap — the rewrite can change its resolution, permissions, or
 * format handling, and nothing goes red. This suite derives the scheme list
 * dynamically from the internal URL router at runtime and asserts each has
 * dedicated test coverage, so adding a new scheme turns this suite red until
 * someone writes its tests.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const TEST_ROOT = join(PACKAGE_ROOT, "test");
const SRC_ROOT = join(PACKAGE_ROOT, "src");

/** Recursively collect every .test.ts file under given roots. */
function collectTestFiles(roots: string[]): string[] {
	const out: string[] = [];
	for (const root of roots) {
		const stack = [root];
		while (stack.length > 0) {
			const dir = stack.pop()!;
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					stack.push(full);
				} else if (entry.endsWith(".test.ts")) {
					out.push(full);
				}
			}
		}
	}
	return out;
}

const ALL_TEST_FILES = collectTestFiles([TEST_ROOT, SRC_ROOT]);

/**
 * An internal URL scheme has a dedicated test if an internal URL test file
 * exists whose name targets that scheme (e.g. `<scheme>-protocol.test.ts`,
 * `<scheme>-*.test.ts`, or compound suites like `issue-pr-protocol.test.ts`).
 */
function hasDedicatedTest(scheme: string): boolean {
	const normalized = scheme.toLowerCase();
	return ALL_TEST_FILES.some(file => {
		if (file.includes("every-scheme-has-test-coverage")) return false;
		if (!file.includes("internal-urls")) return false;
		const base = file.split("/").pop()!;
		return base.includes(normalized);
	});
}

/**
 * Schemes tested only through cross-component suites rather than a dedicated
 * protocol test file. Each entry names the suites that cover it so the
 * assertion is auditable.
 */
const TESTED_VIA_CROSS_SUITE: Record<string, string> = {
	rule: "tested via discovery/github-copilot.test.ts, modes/internal-url-autocomplete.test.ts, and tools/bash-skill-urls.test.ts",
};

describe("every internal URL scheme has test coverage", () => {
	const router = new InternalUrlRouter();
	const allSchemes = [...new Set(router.schemes())].sort();

	it("router schemes are non-empty", () => {
		expect(allSchemes.length).toBeGreaterThan(0);
	});

	for (const scheme of allSchemes) {
		it(`internal URL scheme "${scheme}://" has dedicated test coverage or an audited exemption`, () => {
			const hasFile = hasDedicatedTest(scheme);
			const hasExemption = scheme in TESTED_VIA_CROSS_SUITE;
			expect(
				hasFile || hasExemption,
				`Internal URL scheme "${scheme}://" has no dedicated test file and no cross-suite coverage note. ` +
					"Add a dedicated protocol test file or record the cross-suite tests that cover it.",
			).toBe(true);
		});
	}

	it("the cross-suite exemption list is exhaustive for schemes without a dedicated file", () => {
		const withoutFiles = allSchemes.filter(name => !hasDedicatedTest(name));
		const exempted = Object.keys(TESTED_VIA_CROSS_SUITE);
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_SUITE));
		expect(unaccounted).toEqual([]);

		// A scheme that gains a dedicated file must be removed from the exemption
		// list, or this assertion fails: the list must shrink as coverage grows.
		const stale = exempted.filter(name => hasDedicatedTest(name));
		expect(stale, "These schemes now have dedicated files — remove them from TESTED_VIA_CROSS_SUITE").toEqual([]);
	});
});
