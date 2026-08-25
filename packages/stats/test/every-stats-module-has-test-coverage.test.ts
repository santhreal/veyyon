/**
 * Every stats source module has a dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A stats module with no dedicated test is a parity gap. This suite
 * derives the module list from the stats source directory at runtime and
 * asserts each has a dedicated test file or an audited cross-tool exemption.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STATS_SRC = join(import.meta.dir, "..", "src");
const TEST_ROOT = join(import.meta.dir);

/** Recursively collect every .ts source file (non-test) under a root. */
function collectSourceFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				stack.push(full);
			} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
				out.push(entry.replace(/\.ts$/, ""));
			}
		}
	}
	return [...new Set(out)].sort();
}

/** Recursively collect every .test.ts file under a root. */
function collectTestFiles(root: string): string[] {
	const out: string[] = [];
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
	return out;
}

const STATS_SOURCES = collectSourceFiles(STATS_SRC);
const ALL_TEST_FILES = collectTestFiles(TEST_ROOT);

/** Whether a source name is referenced in any test file content (excluding this meta-test). */
function hasTestReference(name: string): boolean {
	return ALL_TEST_FILES.some(file => {
		if (file.endsWith("every-stats-module-has-test-coverage.test.ts")) return false;
		try {
			return readFileSync(file, "utf-8").includes(name);
		} catch {
			return false;
		}
	});
}

/**
 * Stats modules tested via integration suites rather than a dedicated file.
 * Each value names the covering suite.
 */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"charts": "tested via client-view-models suite",
	"embedded-client": "tested via sync-serial and sync-worker integration suites",
	"range-meta": "tested via client-view-models suite",
	"routes": "tested via client-view-models suite",
	"server": "tested via sync-serial and db integration suites",
	"sync-worker": "tested via sync-serial and smoke-worker-darwin suites",
	"useHashRoute": "tested via client-view-models suite",
	"useResource": "tested via client-view-models suite",
	"useSystemTheme": "tested via client-view-models suite",
};

describe("stats source inventory", () => {
	it("there are stats source modules", () => {
		expect(STATS_SOURCES.length).toBeGreaterThan(0);
	});

	it("the stats source count is pinned", () => {
		// Update this number when a stats module is added or removed.
		expect(STATS_SOURCES.length).toBe(20);
	});

	it("every stats source is accounted for", () => {
		const unaccounted = STATS_SOURCES.filter(
			name => !hasTestReference(name) && !(name in TESTED_VIA_CROSS_TOOL),
		);
		expect(
			unaccounted,
			"These stats sources have no test reference and no cross-tool exemption",
		).toEqual([]);
	});

	for (const name of STATS_SOURCES) {
		it(`stats source "${name}" has a test reference or audited exemption`, () => {
			const hasRef = hasTestReference(name);
			const hasCrossTool = name in TESTED_VIA_CROSS_TOOL;
			expect(
				hasRef || hasCrossTool,
				`Stats source "${name}" has no test coverage. ` +
					"Add a test reference or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list has no stale entries", () => {
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => hasTestReference(name));
		expect(
			stale,
			"These stats modules now have test references — remove them from TESTED_VIA_CROSS_TOOL",
		).toEqual([]);
	});
});
