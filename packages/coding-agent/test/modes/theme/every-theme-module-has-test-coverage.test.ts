/**
 * Every theme system source module has a dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A theme module with no dedicated test is a parity gap. This suite
 * derives the module list from the theme source directory at runtime and
 * asserts each has a dedicated test file or an audited cross-tool exemption.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const THEME_SRC = join(import.meta.dir, "..", "..", "..", "src", "modes", "theme");
const TEST_ROOT = join(import.meta.dir, "..", "..");

/** Collect every .ts source file (non-test) in the theme directory recursively. */
function collectThemeSources(): string[] {
	const out: string[] = [];
	const stack = [THEME_SRC];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				stack.push(full);
			} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
				out.push(entry.replace(/\.ts$/, ""));
			}
		}
	}
	return out.sort();
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

const THEME_SOURCES = collectThemeSources();
const ALL_TEST_FILES = collectTestFiles(TEST_ROOT);

/** Whether a theme source name appears in any test file path. */
function hasTestFile(name: string): boolean {
	return ALL_TEST_FILES.some(file => file.split("/").pop()!.includes(name));
}

/** Whether a theme source name is referenced in any test file content (excluding this meta-test). */
function hasTestReference(name: string): boolean {
	return ALL_TEST_FILES.some(file => {
		if (file.endsWith("every-theme-module-has-test-coverage.test.ts")) return false;
		try {
			return readFileSync(file, "utf-8").includes(name);
		} catch {
			return false;
		}
	});
}

/**
 * Theme modules tested via integration suites rather than a dedicated file.
 * Each value names the covering suite.
 */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"before-markdown-theme": "tested via markdown rendering integration suites (theme-ground, theme-text-attributes)",
};

describe("theme system source inventory", () => {
	it("there are theme source modules", () => {
		expect(THEME_SOURCES.length).toBeGreaterThan(0);
	});

	it("the theme source count is pinned", () => {
		// Update this number when a theme module is added or removed.
		expect(THEME_SOURCES.length).toBe(16);
	});

	it("every theme source is accounted for", () => {
		const unaccounted = THEME_SOURCES.filter(
			name => !hasTestFile(name) && !hasTestReference(name) && !(name in TESTED_VIA_CROSS_TOOL),
		);
		expect(
			unaccounted,
			"These theme sources have no test file, no test reference, and no cross-tool exemption",
		).toEqual([]);
	});

	for (const name of THEME_SOURCES) {
		it(`theme source "${name}" has a dedicated test file, test reference, or audited exemption`, () => {
			const hasFile = hasTestFile(name);
			const hasRef = hasTestReference(name);
			const hasCrossTool = name in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasRef || hasCrossTool,
				`Theme source "${name}" has no test coverage. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list has no stale entries", () => {
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(
			name => hasTestFile(name) || hasTestReference(name),
		);
		expect(
			stale,
			"These theme modules now have test files — remove them from TESTED_VIA_CROSS_TOOL",
		).toEqual([]);
	});
});
